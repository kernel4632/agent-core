/*
spawn / killAll：子进程的生命周期。普通工具的每次读取、每次执行都在一个新的子进程里，
停止就是 kill，不给工具任何反应时间（主进程里的函数本质上杀不掉：一个同步死循环会卡死整个事件循环）。

调用示例：
    const result = await spawn({ mode: 'run', path, args, limit, toolCallId }, internal.procs, { timeout, onOutput })
    killAll(internal.procs)   // agent.stop()：只杀本实例的子进程

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

// 打包时由 scripts/build.ts 的 define 替换成 child 的完整源码；源码直接运行时它不存在。
declare const __AGENT_CORE_CHILD__: string | undefined

// 子进程回来的结果：成功时是 child 发回的内容；被杀 / 超时 / 崩溃时 ok 为 false 并说明原因。
export type ChildResult =
    | { ok: true; meta?: any; output?: any; stop?: boolean; truncated?: boolean }
    | { ok: false; error: string; killed?: boolean; timedOut?: boolean }

/*
spawn：启动一个 child 子进程执行一条指令，等它通过 IPC 回结果后立刻 kill 它并返回。

- 启动后立即加入 procs，退出（无论成败）立即移出；
- 工具自己的 stdout / stderr 实时交给 onOutput（宿主显示工具进度），stderr 尾部留着给崩溃时说明原因；
- timeout 到了就 kill 并返回 { ok: false, timedOut: true }；
- 被 killAll 杀掉返回 { ok: false, killed: true }，由调用方补"已取消"；
- 进程崩溃、没回结果就退出，返回 { ok: false, error: 退出码和 stderr 尾部 }。
永远不抛错：工具的错都是结果，交给模型处理。
*/
export async function spawn(
    request: ChildRequest,
    procs: Set<Subprocess>,
    options: { timeout?: number; onOutput?: (stream: 'stdout' | 'stderr', data: string) => void } = {},
): Promise<ChildResult> {
    const inline = typeof __AGENT_CORE_CHILD__ === 'string' ? __AGENT_CORE_CHILD__ : null
    let answer: ChildResult | null = null                                 // child 回的结果；收到后就不再关心进程怎么退出。
    let timedOut = false
    let stderrTail = ''
    let proc: Subprocess<any, 'pipe', 'pipe'>
    try {
        proc = Bun.spawn([process.execPath, inline ? '-' : fileURLToPath(new URL('./child.ts', import.meta.url))], {
            stdin: inline ? new Blob([inline]) : 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, AGENT_CORE_CHILD: '1', BUN_BE_BUN: '1' },
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
    // 两路输出各用一个解码器（共用会把被拆开的汉字拼到另一路上），读到就转发。
    const relay = async (stream: ReadableStream<Uint8Array>, name: 'stdout' | 'stderr') => {
        const decoder = new TextDecoder()
        try {
            for await (const chunk of stream) {
                const text = decoder.decode(chunk, { stream: true })
                if (name === 'stderr') stderrTail = (stderrTail + text).slice(-2000)
                try { options.onOutput?.(name, text) } catch { /* 宿主回调出错不影响工具 */ }
            }
        } catch { /* 进程被杀时管道会被重置，当成流结束 */ }
    }
    const reading = Promise.all([relay(proc.stdout, 'stdout'), relay(proc.stderr, 'stderr')])
    const timer = options.timeout && Number.isFinite(options.timeout) ? setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, options.timeout) : null
    const code = await proc.exited
    if (timer) clearTimeout(timer)
    procs.delete(proc)
    await Promise.race([reading, Bun.sleep(50)])                          // 给输出一点时间读完；孙进程占着管道时不无限等。
    if (answer) return answer
    if (timedOut) return { ok: false, timedOut: true, error: `工具执行超时（${options.timeout}ms）` }
    if (proc.signalCode === 'SIGKILL') return { ok: false, killed: true, error: '工具执行已取消' }
    return { ok: false, error: `工具子进程异常退出（退出码 ${code}）${stderrTail ? `：${stderrTail.trim()}` : ''}` }
}

/*
killAll：立刻 kill procs 里的全部子进程（SIGKILL，不等它们收尾），并清空集合。
各自的 spawn 调用会因此以 killed 结束。
*/
export function killAll(procs: Set<Subprocess>): void {
    for (const proc of procs) proc.kill('SIGKILL')
    procs.clear()
}
