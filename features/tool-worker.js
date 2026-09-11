/*
工具在这里真正执行。它不是普通模块，不能 import 进来调用：

    import ToolWorker from './tool-worker.js'  // 错误：本文件没有任何导出

正确用法是被 features/tool.js 当成文本内联、从 blob: 地址启动成一个 Worker：

    import source from './tool-worker.js' with { type: 'text' }
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
    worker.postMessage({ callId: '1', url: 'file:///D:/tools/read.js', name: 'read', input: { path: 'a.txt' } })

一个 Worker 长期存活、同时服务多次调用，所以每条消息都带 callId，主线程靠它把结果认领回对应的那次调用。

    主线程 → Worker   { callId, url, name, input }                              执行哪个文件里的哪个工具
    Worker → 主线程   { callId, type: 'output', stream, data }                  工具产生了一段实时输出
    Worker → 主线程   { callId, type: 'done', output, stop }                    工具跑完了，output 已经是模型能直接读的形态
    Worker → 主线程   { callId, type: 'error', message }                        工具抛错了

工具文件长这样，默认导出一个工具或一组工具：

    export default {
        name: 'read',
        description: '读取文件',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        async execute(input) { return await Bun.file(input.path).text() },
    }

工具作者不需要写任何流式输出代码：console.log 和 Bun.spawn 的子进程输出都会被自动转发；
execute 写成 async * 时，每个 yield 也会实时发出去。

约束（方案成立的前提，改这个文件时必须守住）：
本文件内不能出现任何 import 或 require。它以 blob: 身份运行，相对路径和裸包名会按进程 cwd 解析、必然出错；
工具文件由主线程以绝对 file:// URL 传进来，不受这条限制影响。
*/


const decoder = new TextDecoder()               // 子进程输出是字节流，转成文本才能发给主线程。
const encoder = new TextEncoder()               // 重放给工具的那一份要再变回字节流。
const KEEP = 8 << 20                            // 替工具留着的子进程输出上限（8MB）：正常的构建/测试日志都装得下，工具永远不读时内存也有明确天花板。

let current = null                              // 当前正在执行的 callId，console 输出靠它认领归属；空闲时为 null。

// --- 把一段实时输出报给主线程 ---
// 空闲时直接丢弃：工具返回之后还在打日志（自己起了不 await 的后台任务），
// 那些输出不属于任何一次调用，发出去只会被记到下一次调用头上。
const report = (stream, data) => current && postMessage({ callId: current, type: 'output', stream, data })


// --- 子进程输出：执行器是唯一读者，读到的每段既发给主线程，也留一份给工具自己读 ---
// 不用 tee()：tee 的两路里只要有一路没人读，另一路读多少就在内存里堆多少，没有上限。
const relay = (source, stream) => {
    const kept = []                                                     // 留给工具读的副本，只保留尾部 KEEP 字节。
    let size = 0                                                        // 副本当前占用的字符数。
    let ended = false                                                   // 子进程这条流是否已经读完。
    let wake = null                                                     // 工具正等着新数据时，用它唤醒。

    void (async () => {
        for await (const chunk of source) {
            const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
            report(stream, text)                                        // 实时转发给主线程，发完即走，不占内存。
            kept.push(text)                                             // 同一段也留给工具，它可能自己要读。
            size += text.length
            while (size > KEEP) size -= kept.shift().length             // 工具不读时丢最旧的，内存有明确上限。
            wake?.()
        }
        ended = true                                                    // 子进程关流了，等待中的工具该收尾了。
        wake?.()
    })()

    // 工具拿到的是这份重放流，不是原始管道，所以原始管道永远只有一个读者。
    return new ReadableStream({
        async pull(controller) {
            while (!kept.length && !ended) await new Promise(resolve => { wake = resolve }) // 没有新数据就挂起，等 relay 唤醒。
            if (kept.length) controller.enqueue(encoder.encode(kept.shift()))
            else controller.close()                                     // 数据取完且子进程已结束，工具读到流尾。
        },
    })
}


// --- 劫持 Bun.spawn：工具照常写 spawn，子进程输出自动变成流式事件 ---
const spawn = Bun.spawn
Bun.spawn = (command, options = {}) => {
    const child = spawn(command, {
        ...options,
        stdout: options.stdout ?? 'pipe',                               // 工具自己指定了就不插手，那是它要自己读。
        stderr: options.stderr ?? 'pipe',
    })

    const stdout = child.stdout && relay(child.stdout, 'stdout')        // 接管这一路，工具改读重放流。
    const stderr = child.stderr && relay(child.stderr, 'stderr')

    return new Proxy(child, {
        get(target, property) {
            if (property === 'stdout') return stdout
            if (property === 'stderr') return stderr
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value // kill()、exited 这些照常可用。
        },
    })
}


// --- 劫持 console：工具里的 console.log 直接变成流式输出 ---
// 只发给主线程、不再写本进程 stdout：同一条输出同时走 postMessage 和 console 会稳定触发 Bun 的内部断言，整个进程 panic。
for (const name of ['log', 'info', 'warn', 'error']) {
    // 字符串原样输出，其余交给 Bun.inspect —— 和 console 自己的行为一致；
    // 不用 String()，它会被 Object.create(null) 这类没有 toString 的值抛穿，把跑成功的工具报成失败。
    console[name] = (...args) => report('console', args.map(value => typeof value === 'string' ? value : Bun.inspect(value)).join(' '))
}


// --- 异步生成器工具：每个 yield 立刻发出去，最后把全部片段作为返回值 ---
const collect = async result => {
    if (!result || typeof result[Symbol.asyncIterator] !== 'function') return result
    const chunks = []
    for await (const chunk of result) {
        chunks.push(chunk)
        report('result', chunk)                                         // 逐段实时送达，上层不用等工具跑完。
    }
    return chunks
}


// --- 成形：在跨进程之前就把返回值变成模型能读的输出块 ---
// 放在这里而不是主线程，是因为这一步会执行工具作者写的 toModelOutput、也会做 JSON 化，
// 两者都可能抛错；抛在这里只是一条正常的工具失败，抛在主线程会让那次调用永远不结算。
const shape = (tool, result) => {
    const value = result?.output ?? result                              // 工具可以返回 { output } 对象，也可以直接返回值。
    const output = tool.toModelOutput ? tool.toModelOutput(value)       // 工具自带格式化函数时优先用它。
        : value === undefined || value === null || value === '' ? { type: 'text', value: '工具执行成功，但没有输出' }
        : typeof value === 'string' ? { type: 'text', value }
        : { type: 'json', value }

    // 跨进程只传纯 JSON，自带格式化的那条路也一样要过这一关：
    // Date 变字符串、NaN 变 null、循环引用在这里变成一条正常的工具错误，不会写进 history 把 Agent 毒死。
    return JSON.parse(JSON.stringify(output))
}


// --- 收到一次执行请求：找工具 → 跑工具 → 把成形后的结果发回去 ---
self.onmessage = async ({ data }) => {
    current = data.callId                                                       // 本次调用的身份，console 输出也归到它名下。
    try {
        const module = await import(data.url)                                   // Worker 是独立环境，工具文件在这里重新加载。
        const tool = [module.default].flat().find(one => one.name === data.name) // 按名字认工具，和主线程建表时用的是同一条规则，不会错位。
        const result = await collect(await tool.execute(data.input))
        postMessage({ callId: data.callId, type: 'done', output: shape(tool, result), stop: result?.stop === true }) // stop 是工具主动要求结束整个循环。
    } catch (error) {
        postMessage({ callId: data.callId, type: 'error', message: error?.message || String(error) }) // 工具抛错、toModelOutput 抛错、返回值 JSON 化失败，对模型来说都是"这个工具没成功"。
    } finally {
        current = null                                                          // 交还身份：这之后再有输出就不属于任何一次调用了。
    }
}
