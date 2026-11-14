/*
spawn / killAll：子进程的生命周期。普通工具的每次读取、每次执行都在一个新的子进程里，
停止就是 kill，不给工具任何反应时间（主进程里的函数本质上杀不掉：一个同步死循环会卡死整个事件循环）。

调用示例：
    const result = await spawn({ mode: 'run', path, args, limit, toolCallId }, internal.procs, { timeout, onOutput })
    await killAll(internal.procs)   // agent.stop()：只杀本实例的子进程，等它们退出，返回个数

启动方式：用 process.execPath（当前运行时自己）而不是写死 'bun'——将来宿主打成 Bun 单文件可执行程序时，
execPath 就是那个程序，配合 BUN_BE_BUN=1 让它表现得像 bun 本身。
- 开发 / 直接跑源码：按 child.ts 的文件路径启动；
- 单文件 dist：scripts/build.ts 把 child.ts 连同 shape 打包成一段源码，通过 __AGENT_CORE_CHILD__ 常量内联进来，
  以 `<execPath> -` 启动、从 stdin 喂源码（不依赖任何包内文件路径）。

procs 是 Agent 实例私有的 Set，由调用方传入——放在本模块里会变成全进程共享，一个实例 stop 会杀掉别人的工具。
本文件不 import child.ts 的任何值（只 import type），没有模块级可变状态。
*/

import { fileURLToPath } from 'node:url'
import type { Subprocess } from 'bun'
import type { ChildRequest } from './child.ts'
import { tell } from '../utils/errors.ts'

// 替模型攒着的"已产出内容"上限（字符）：工具超时 / 被取消 / 崩溃时把它连同原因交给模型，让它知道跑到了哪里。
// 即使宿主没设 maxToolOutput 也要有上限：一个边跑边刷日志、又长期不返回的工具，否则能把主进程内存吃光。
const MAX_PARTIAL = 1 << 20

// 打包时由 scripts/build.ts 的 define 替换成 child 的完整源码；源码直接运行时它不存在。
declare const __AGENT_CORE_CHILD__: string | undefined

// 子进程回来的结果：成功时是 child 发回的内容；被杀 / 超时 / 崩溃时 ok 为 false 并说明原因。
export type ChildResult =
    | { ok: true; meta?: any; output?: any; stop?: boolean; truncated?: boolean }
    | { ok: false; error: string; killed?: boolean; timedOut?: boolean }

/*
spawn：启动一个 child 子进程执行一条指令，等它通过 IPC 回结果后立刻 kill 它并返回。

- 启动后立即加入 procs，退出（无论成败）立即移出；
- 工具自己的 stdout / stderr 实时交给 onOutput（宿主显示工具进度），同时攒进一个有上限的头尾缓冲
  （开头 70% + 结尾 30%，上限取 limit，没有就 MAX_PARTIAL），没拿到结果就结束时，错误里带上这些已产出的内容；
- timeout 到了就 kill 并返回 { ok: false, timedOut: true }；
- 被 killAll 杀掉（killAll 先把它移出 procs 再杀）返回 { ok: false, killed: true }，由调用方补"已取消"；
- 别的原因死掉（崩溃、被系统 OOM 杀掉——同样是 SIGKILL，但不是我们杀的）返回 { ok: false, error: 退出原因 }，不算取消。
永远不抛错：工具的错都是结果，交给模型处理。
*/
export async function spawn(
    request: ChildRequest,
    procs: Set<Subprocess>,
    options: { timeout?: number; onOutput?: (stream: 'stdout' | 'stderr', data: string) => unknown } = {},
): Promise<ChildResult> {
    const inline = typeof __AGENT_CORE_CHILD__ === 'string' ? __AGENT_CORE_CHILD__ : null
    let answer: ChildResult | null = null                                 // child 回的结果；收到后就不再关心进程怎么退出。
    let timedOut = false
    // 头尾缓冲：头部攒满 70% 后只滚动保留尾部 30%，中间丢掉的字符数记在 dropped 里。
    const cap = request.mode === 'run' && request.limit !== undefined && Number.isFinite(request.limit) ? request.limit : MAX_PARTIAL
    let head = '', tail = '', dropped = 0
    let proc: Subprocess<any, 'pipe', 'pipe'>
    try {
        proc = Bun.spawn([process.execPath, inline ? '-' : fileURLToPath(new URL('./child.ts', import.meta.url))], {
            stdin: inline ? new Blob([inline]) : 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
            // AGENT_CORE_CHILD 的值告诉 child：BUN_BE_BUN 是不是我们替它加的（是就别漏给工具起的孙进程）。
            env: { ...process.env, AGENT_CORE_CHILD: process.env.BUN_BE_BUN === undefined ? 'added' : 'kept', BUN_BE_BUN: '1' },
            ipc(message, child) {
                if (message?.ready) return void child.send(request)        // 握手完成才派活，消息不会丢。
                answer = message as ChildResult
                child.kill('SIGKILL')                                     // 一个子进程只做一件事：拿到结果就收掉。
            },
        })
    } catch (error) {
        return { ok: false, error: `无法启动工具子进程：${(error as Error)?.message ?? String(error)}` }
    }
    procs.add(proc)
    // 两路输出各用一个解码器（共用会把被拆开的汉字拼到另一路上），读到就转发，并攒进头尾缓冲。
    const relay = async (stream: ReadableStream<Uint8Array>, name: 'stdout' | 'stderr') => {
        const decoder = new TextDecoder()
        try {
            for await (const chunk of stream) {
                const text = decoder.decode(chunk, { stream: true })
                if (head.length < cap * 0.7) head += text
                else { tail += text; if (tail.length > cap * 0.3) { const cut = tail.length - Math.floor(cap * 0.3); dropped += cut; tail = tail.slice(cut) } }
                void tell(data => options.onOutput?.(name, data), text)            // 宿主回调出错（含异步拒绝）不影响工具。
            }
        } catch { /* 进程被杀时管道会被重置，当成流结束 */ }
    }
    const reading = Promise.all([relay(proc.stdout, 'stdout'), relay(proc.stderr, 'stderr')])
    const timer = options.timeout && Number.isFinite(options.timeout) ? setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, options.timeout) : null
    const code = await proc.exited
    if (timer) clearTimeout(timer)
    const cancelled = !procs.delete(proc) && !timedOut && !answer        // 已经不在 procs 里 = killAll 先移出再杀的，这才是"取消"。
    await Promise.race([reading, Bun.sleep(50)])                          // 给输出一点时间读完；孙进程占着管道时不无限等。
    if (answer) return answer
    // 已产出的内容放在原因前面，模型能看到工具停在了哪一步。
    const partial = (dropped ? `${head}\n\n……[输出过长，中间省略 ${dropped} 个字符]……\n\n${tail}` : head + tail).trim()
    const withPartial = (reason: string) => partial ? `${partial}\n${reason}` : reason
    if (timedOut) return { ok: false, timedOut: true, error: withPartial(`工具执行超时（${options.timeout}ms）`) }
    if (cancelled) return { ok: false, killed: true, error: withPartial('工具执行已取消') }
    const why = proc.signalCode ? `被信号 ${proc.signalCode} 终止${proc.signalCode === 'SIGKILL' ? '（可能是内存不足被系统杀掉）' : ''}` : `退出码 ${code}`
    return { ok: false, error: withPartial(`工具子进程异常退出（${why}）`) }
}

/*
killAll：先清空集合、再 kill 里面的全部子进程（SIGKILL，不给它们收尾的机会）——先移出是 spawn 区分"被取消"和"自己死掉"的依据，
等到它们全部确认退出后返回被杀的个数（stop() 据此告诉宿主"已经停干净了"）。
各自的 spawn 调用会因此以 killed 结束。
*/
export async function killAll(procs: Set<Subprocess>): Promise<number> {
    const all = [...procs]
    procs.clear()
    for (const proc of all) proc.kill('SIGKILL')
    await Promise.all(all.map(proc => proc.exited.catch(() => {})))     // SIGKILL 不可拦截，这里很快就返回。
    return all.length
}
