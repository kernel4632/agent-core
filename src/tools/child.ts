/*
子进程入口：被 tools/spawn 启动（开发时按本文件路径启动；打包后 child + shape 被内联成一段源码，从 stdin 喂给子进程）。
主进程从不 import 工具文件，所以工具顶层的死循环、副作用只会卡住这个子进程，stop() 直接 kill 即可。

协议走 Bun 的 IPC 通道（和工具自己的 stdout / stderr 分开，工具随便打日志都不会弄坏协议）：
    子 → 主   { ready: true }                                   起来了，可以派活
    主 → 子   { mode: 'meta', path }                            读元数据
    主 → 子   { mode: 'run', path, args, limit, toolCallId }    执行一次
    子 → 主   { ok: true, meta }                                mode 'meta' 的结果（不含 run）
    子 → 主   { ok: true, output, stop?, truncated? }           mode 'run' 的结果（已经过 shape）
    子 → 主   { ok: false, error }                              导入失败、契约不符、run 抛错
一个子进程只做一件事：主进程收到结果后立刻 kill 它，所以这里不需要任何清理逻辑。
工具的 console.log、process.stdout.write、generator 的每次 yield、以及它自己起的孙进程的输出，都写到本进程的 stdout / stderr，
由 spawn 实时转给宿主（onToolOutput），工具超时 / 被杀时也靠这些已产出的内容告诉模型"跑到了哪里"。
孙进程的 stdout / stderr 默认是管道（工具要自己读结果），所以这里接管 Bun.spawn：管道里读到的每段既写到本进程输出，
也留一份有上限的副本重放给工具，工具照常读 proc.stdout，感觉不到区别。

它隔离的是生命周期，不是权限：工具拥有和宿主相同的权限（读写文件、联网、读环境变量），约束工具是上层的事。
本文件只导入同目录的 shape；工具文件靠动态 import 加载。只有带 AGENT_CORE_CHILD 环境变量启动时才进入 main（值说明 BUN_BE_BUN 是不是 spawn 替我们加的），
被类型检查或其它模块导入时什么都不做。
*/

import { pathToFileURL } from 'node:url'
import type { ToolDefinition } from '../types.ts'
import { shape } from './shape.ts'

// 替工具留着的孙进程输出上限（8MB）：正常构建 / 测试日志都装得下，工具永远不读时内存也有天花板。
const KEEP = 8 << 20

// 主进程发来的一条指令。
export type ChildRequest =
    | { mode: 'meta'; path: string }
    | { mode: 'run'; path: string; args: unknown; limit?: number; toolCallId: string }

/*
check：校验工具文件的默认导出是否符合契约 { name, description, parameters, run }。
name / description 必须是非空字符串，parameters 必须是 type 为 object 的 JSON Schema，run 必须是函数，
timeout 若有必须是正数。不符合时抛出说明哪一项不对的错误，load 会把它作为警告带回给宿主。
*/
export function check(value: unknown, path: string): ToolDefinition {
    const tool = value as Partial<ToolDefinition> | undefined
    const problem = !tool || typeof tool !== 'object' ? '没有默认导出一个工具对象'
        : typeof tool.name !== 'string' || !tool.name.trim() ? 'name 必须是非空字符串'
        : typeof tool.description !== 'string' || !tool.description.trim() ? 'description 必须是非空字符串'
        : !tool.parameters || typeof tool.parameters !== 'object' || tool.parameters.type !== 'object' ? "parameters 必须是 type 为 'object' 的 JSON Schema"
        : typeof tool.run !== 'function' ? 'run 必须是函数'
        : tool.timeout !== undefined && !(typeof tool.timeout === 'number' && tool.timeout > 0) ? 'timeout 必须是正数（毫秒）'
        : tool.toModelOutput !== undefined && typeof tool.toModelOutput !== 'function' ? 'toModelOutput 必须是函数'
        : null
    if (problem) throw new TypeError(`工具文件 ${path}：${problem}`)
    return tool as ToolDefinition
}

/*
main：先告诉主进程"起来了"，等一条指令 → 动态 import 工具文件 → check → 按 mode 读元数据或执行 run（结果交给 shape）
→ 通过 IPC 回一条结果。任何异常都变成 { ok: false, error }。
run 返回的是生成器（async * 写法）时，每个 yield 立刻写到 stdout（宿主实时看到进度），全部片段一起作为最终结果。
*/
export async function main(): Promise<void> {
    // 别让工具起的孙进程（比如又一个 bun）误以为自己也是工具子进程；BUN_BE_BUN 是 spawn 为启动单文件程序加的，宿主原本没有就别漏给孙进程。
    if (process.env.AGENT_CORE_CHILD === 'added') delete process.env.BUN_BE_BUN
    delete process.env.AGENT_CORE_CHILD
    // 接管 Bun.spawn：孙进程的管道输出转写到本进程（spawn 实时转给宿主），同时重放给工具自己读。工具指定了别的 stdout / stderr 就不插手。
    const original = Bun.spawn
    const relay = (source: ReadableStream<Uint8Array>, write: (text: string) => unknown) => {
        const decoder = new TextDecoder()                                 // 每条流各用一个解码器：共用会把被拆开的汉字拼到别的流上。
        const kept: string[] = []                                         // 留给工具读的副本，只保留尾部 KEEP 个字符。
        let size = 0, ended = false, wake = null as (() => void) | null
        void (async () => {
            try {
                for await (const chunk of source) {
                    const text = decoder.decode(chunk, { stream: true })
                    write(text)                                           // 实时写到本进程输出。
                    kept.push(text.length > KEEP ? text.slice(-KEEP) : text)
                    size += kept.at(-1)!.length
                    while (size > KEEP && kept.length) size -= kept.shift()!.length // 工具不读时丢最旧的，内存有上限。
                    wake?.()
                }
            } catch { /* 管道被重置、孙进程被杀：当成流结束 */ }
            ended = true
            wake?.()
        })()
        const encoder = new TextEncoder()
        return new ReadableStream<Uint8Array>({                           // 工具拿到的是重放流，原始管道永远只有一个读者。
            async pull(controller) {
                while (!kept.length && !ended) await new Promise<void>(resolve => { wake = resolve })
                if (kept.length) { const item = kept.shift()!; size -= item.length; controller.enqueue(encoder.encode(item)) }
                else controller.close()
            },
        })
    }
    Bun.spawn = ((...args: any[]) => {
        const options = (Array.isArray(args[0]) ? args[1] : args[0]) ?? {}
        const child = original(...(args as [any, any]))
        const stdout = options.stdout === undefined || options.stdout === 'pipe' ? relay(child.stdout as any, text => process.stdout.write(text)) : child.stdout
        const stderr = options.stderr === 'pipe' ? relay(child.stderr as any, text => process.stderr.write(text)) : child.stderr
        return new Proxy(child, {                                         // stdout / stderr 换成重放流，kill()、exited 这些照常可用。
            get: (target, property) => property === 'stdout' ? stdout : property === 'stderr' ? stderr
                : typeof (target as any)[property] === 'function' ? (target as any)[property].bind(target) : (target as any)[property],
        })
    }) as typeof Bun.spawn
    const send = (message: unknown) => process.send?.(message)
    process.on('disconnect', () => process.exit(0))                       // 主进程没了：别留孤儿进程。
    process.once('message', async (request: ChildRequest) => {
        try {
            const module = await import(pathToFileURL(request.path).href)
            const tool = check(module.default, request.path)
            if (request.mode === 'meta') {
                const { name, description, parameters, timeout } = tool
                return send({ ok: true, meta: { name, description, parameters, ...(timeout ? { timeout } : {}) } })
            }
            let result: any = await tool.run(request.args)
            // 生成器 / 迭代器（同步、异步都收）：既要 next 又要可迭代，数组不会被误判。
            if (result && typeof result.next === 'function' && (typeof result[Symbol.asyncIterator] === 'function' || typeof result[Symbol.iterator] === 'function')) {
                const chunks: unknown[] = []
                for await (const chunk of result) {
                    chunks.push(chunk)
                    process.stdout.write(typeof chunk === 'string' ? chunk : `${JSON.stringify(chunk)}\n`) // 每个片段立刻送达宿主。
                }
                result = chunks
            }
            const shaped = await shape(result, { limit: request.limit, toModelOutput: tool.toModelOutput, input: request.args, toolCallId: request.toolCallId })
            await new Promise(resolve => process.stdout.write('', resolve))  // 先让已写出的输出落到管道里：主进程收到结果就会 kill 本进程。
            send({ ok: true, ...shaped })
        } catch (error) {
            send({ ok: false, error: (error as Error)?.message || String(error) }) // 导入失败、契约不符、run 抛错：对模型都是"这个工具没成功"。
        }
    })
    send({ ready: true })
}

// 只有被 spawn 当作工具子进程启动时才运行。
if (process.env.AGENT_CORE_CHILD) void main()
