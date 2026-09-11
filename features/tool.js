/*
工具这个主体的全部操作都在这里：从目录里找出工具、把工具交给沙箱执行。

    // 积木 1：扫描工具目录，得到一份独立的工具集合
    const tools = await Tool.scan('./tools')
    // tools.schema   → 给 LLM 的 AI SDK 标准工具描述，直接放进 LLM.chat 的 tools
    // tools.handlers → 给执行器用的工具地址表，直接放进 Tool.execute 的 handlers

    // 积木 2：执行工具（模型要调工具时调用）
    const result = await Tool.execute({
        name: 'finish',              // 要执行哪个工具
        input: { result: '任务完成' }, // 工具参数，直接传给工具的 execute
        handlers: tools.handlers,    // 工具地址表，用来找到 finish 在哪个文件里
        signal: abortSignal,         // 触发即杀，工具瞬间死
        onOutput: output => {},      // 工具产生一段输出时调用，调用方决定如何展示或转发
    })
    // result = { output, stop }            工具正常结束，output 是模型能直接读的输出块
    // result = { output, error }           工具抛错了，错误也作为一条结果交给模型
    // result = { output, interrupted }     被 signal 取消，已产出的内容一起还给模型

工具跑在 Worker 里（见 tool-worker.js），所以工具碰不到 Agent 的任何状态，
死循环的工具也能被主线程一刀杀掉——进程内的 await 永远做不到这一点。

同一套工具集合共用一池 Worker，用完还池：Bun 里每新建一个 Worker 就会永久留下约 22MB，
按次新建时 200 次调用能把内存顶到 4.5GB，还池之后同样 200 次只涨几十 MB。
一次调用独占一个 Worker，所以并发跑的两个工具不会把 console 输出串到一起；
池子多大只取决于峰值并发数，跟调用了多少次无关。
取消时只杀 signal 相同的那些 Worker——Loop 给同一轮所有并行工具的本来就是同一个 signal，
"取消"在语义上就是"这一轮全部取消"；另一台 Agent 共用同一份工具集合时不会被连坐。
空闲 Worker 一律 unref，所以跑过工具的进程该退出时仍然能退出。
*/

import { pathToFileURL } from 'node:url'
import { jsonSchema } from 'ai'
import workerSource from './tool-worker.js' with { type: 'text' } // Worker 源码以文本引入，打包成单文件时会被原样内联成字符串。

// Worker 源码在进程内变成一个 blob: 地址，整个进程共用一份，不依赖磁盘上还存不存在 tool-worker.js。
const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))

const sandboxes = new WeakMap() // 工具集合 → 它专属的沙箱。按集合隔离，多个 Agent 各用各的，互不干扰。
let sequence = 0                // 调用流水号，一个沙箱同时跑多次调用时靠它区分谁是谁。


// --- 扫描工具目录，返回一份完全独立的工具集合 ---
// 不写任何模块级变量，所以多次扫描互不影响，多个 Agent 可以各用各的工具目录。
const scan = async (directory) => {
    const schema = {}   // 工具名 → 给 LLM 的工具描述（不含执行信息）。
    const handlers = {} // 工具名 → 工具在哪个文件里（不给 LLM 看）。
    const files = []

    // 先收集完整文件列表再排序，保证每次扫描同一目录的加载顺序都一样。
    for await (const file of new Bun.Glob('**/*.js').scan({ cwd: directory, absolute: true, onlyFiles: true })) files.push(file)
    files.sort()

    for (const file of files) {
        const url = pathToFileURL(file).href                                 // 绝对 file:// 地址；Worker 靠它自己重新加载工具文件（函数没法跨进程传）。
        const module = await import(url)

        for (const tool of [module.default].flat()) {                        // 一个文件可以导出一个工具，也可以导出一组工具。
            // scan 是工具文件进入系统的唯一入口，"什么算工具"只在这里判定一次。
            // 跳过而不是报错，工具目录里才能自由放共享常量、辅助函数和测试文件。
            if (!tool?.name || typeof tool.execute !== 'function') continue

            const { execute, toModelOutput, ...modelTool } = tool            // 执行相关的字段剥离出来，剩下的才给模型看。

            // schema 只放模型需要的东西：工具叫什么、干什么、要什么参数。
            schema[tool.name] = {
                ...modelTool,
                inputSchema: tool.inputSchema?.['~standard']
                    ? tool.inputSchema                                       // 工具作者用 zod 之类写的，本来就是标准格式。
                    : jsonSchema({ type: 'object', properties: {}, ...tool.inputSchema }), // 缺什么补什么：无参工具也必然带一份合法 Schema（少了它 Anthropic 和 OpenAI 都会 400），工具自己写了的字段一个不丢。
            }

            handlers[tool.name] = { url }                                    // 只记住工具在哪个文件；具体是文件里的哪一个，Worker 按名字自己找。
        }
    }

    return { schema, handlers }
}


// --- 取得这套工具专属的沙箱：一池 Worker，按工具集合隔离 ---
const sandboxOf = handlers => {
    const cached = sandboxes.get(handlers)
    if (cached) return cached

    const sandbox = { idle: [], busy: new Map() } // idle：空闲 Worker；busy：正在干活的 Worker → 它手上那次调用。
    sandboxes.set(handlers, sandbox)
    return sandbox
}


// --- 借一个 Worker：优先用空闲的，没有才新建 ---
// 一次调用独占一个 Worker，所以 Worker 里"现在是哪次调用"永远没有歧义——
// 并发跑两个工具时，它们的 console 输出不会互相串台。
// 用完还池，所以常驻内存只跟峰值并发数有关，不跟调用次数有关。
const borrow = sandbox => {
    const reused = sandbox.idle.pop()
    if (reused) {
        reused.ref()    // 借出期间要吊住事件循环，否则工具还没跑完进程就退了。
        return reused
    }

    const worker = new Worker(workerUrl)

    worker.addEventListener('message', ({ data }) => {
        const call = sandbox.busy.get(worker)
        if (call?.id !== data.callId) return                            // 上一次调用的迟到消息；这个 Worker 已经换人了，丢掉。

        if (data.type === 'output') {
            call.output.push(String(data.data))                         // 攒着，中断时把已产出的内容一起还给模型。
            call.onOutput?.({ tool: call.name, stream: data.stream, data: data.data }) // 实时通知上层，上层决定如何展示。
            return
        }

        sandbox.busy.delete(worker)                                     // 这次干完了，
        worker.unref()                                                  // 空闲 Worker 不能吊住事件循环，否则跑过一次工具的进程就再也退不出去。
        sandbox.idle.push(worker)                                       // 还回池里等下一次。
        if (data.type === 'error') call.finish({ output: { type: 'error-text', value: `工具执行失败：${data.message}` }, error: data.message }) // 工具失败也是一条结果，模型需要知道。
        else call.finish({ output: data.output, stop: data.stop })      // output 在 Worker 里就已经成形，主线程不再加工。
    })

    // Worker 整个死掉（工具里 process.exit、原生崩溃、工具文件语法错误）时只有这两个事件、
    // 没有 message 也没有 error 结果；不接住它们，这次调用就永远不结算，整个 Agent 会无声卡死。
    const collapse = reason => {
        const call = sandbox.busy.get(worker)
        sandbox.busy.delete(worker)
        sandbox.idle = sandbox.idle.filter(one => one !== worker)       // 死掉的 Worker 不能再被借出去。
        call?.finish({ output: { type: 'error-text', value: `工具执行失败：${reason}` }, error: reason })
    }
    worker.addEventListener('close', event => collapse(`工具沙箱退出（代码 ${event.code}）`))
    worker.addEventListener('error', event => collapse(event.message || '工具沙箱异常'))

    return worker
}


// --- 执行一个工具。handlers 必须由调用方明确传入，不存在默认工具表 ---
const execute = ({ name, input, handlers, signal, onOutput }) => {
    const handler = handlers?.[name] // 用工具名从地址表里找到它在哪个文件。
    if (!handler?.url) throw new Error(`Tool ${name} was not found in handlers`) // 认 url 而不是认对象，'__proto__' 这种名字才不会蒙混过关。

    const sandbox = sandboxOf(handlers)
    const call = { id: String(++sequence), name, signal, onOutput, output: [], done: false }

    return new Promise(resolve => {
        // 取消：把这一次运行的工具全部杀掉，触发即死，已产出的输出拼进结果还给模型。
        // 只杀 signal 相同的那些——Loop 给同一轮所有并行工具的是同一个 signal，"取消"就是"这一轮全部取消"；
        // 另一台 Agent 用着同一份工具集合时，它的工具不会被连坐杀掉。
        // 用 resolve 而不是 reject —— 取消也是一条模型能读的工具结果，历史里不会留下没人应答的调用。
        const interrupted = running => ({ output: { type: 'error-text', value: `${running.output.join('')}\n工具执行已中断` }, interrupted: true })
        const stop = () => {
            for (const [worker, running] of [...sandbox.busy]) {
                if (running.signal !== signal) continue                  // 不是这一轮的工具，让它继续跑。
                sandbox.busy.delete(worker)
                worker.terminate()                                       // 工具此刻正在跑什么都不重要，Worker 被杀就是杀；杀掉的不回池。
                running.finish(interrupted(running))
            }
            call.finish(interrupted(call))                               // 还没借到 Worker 就被取消的这次调用，也在这里收口，不然它永远不结算。
        }

        // 四条收尾路径（跑完、抛错、Worker 死掉、被取消）共用这一个出口，所以"结算两次"在结构上不存在。
        call.finish = result => {
            if (call.done) return                                        // 已经结算过了，后到的消息不再改变结果。
            call.done = true
            signal?.removeEventListener('abort', stop)                   // 一次调用只挂一个监听器，跑完就摘，不随调用次数累积。
            resolve(result)
        }

        signal?.addEventListener('abort', stop, { once: true })
        if (signal?.aborted) return stop()                               // 进来之前就已经取消了，直接停。

        const worker = borrow(sandbox)
        sandbox.busy.set(worker, call)
        worker.postMessage({ callId: call.id, url: handler.url, name, input }) // 告诉沙箱：去哪个文件、找哪个名字的工具、用什么参数。
    })
}


export default { scan, execute }
