/*
工具进程这一半：主线程把工具文件地址和执行参数发进来，这里加载工具、跑它、把结果成形成模型能读的输出块。
本文件不是普通模块，调用方不要 import 它——它没有任何导出，靠被 features/tool.js 当文本内联进一个新的 bun 进程才生效：

    import source from './tool-process.js' with { type: 'text' }   // tool.js 的写法
    const child = Bun.spawn([runtime, '-'], { stdin: 'pipe', ipc: handle })   // runtime 多为 process.execPath
    child.stdin.write(source); child.stdin.end()

隔着进程的约定是几条消息，工具作者和调用方都不需要手写它们：
    主线程 → 工具进程   { callId, url, name, input, signal }      执行哪个文件里的哪个工具；signal 是序列化后的取消信号，本进程还原成 AbortSignal 交给工具
    工具进程 → 主线程   { type: 'ready' }                        我起来了，可以派活
    工具进程 → 主线程   { callId, type: 'output', stream, data } 工具产生了一段实时输出
    工具进程 → 主线程   { callId, type: 'done', output, stop }   跑完了，output 已经是模型能直接读的形态
    工具进程 → 主线程   { callId, type: 'error', message }       工具抛错了
内存工具不走这里：它们在主进程里由 tool.js 的 inProcess 直接调用。

它隔离的是生命周期，不是环境。工具在这里拥有和 Agent 完全相同的权限：
读写任意文件、执行任意命令、联网、读到父进程的全部环境变量（包括 apiKey）。
这是有意的——「电脑任务 agent」的工具本来就得能干这些，约束工具是上层的事，不是这个包的事。
它真正隔离的是四样：失控（死循环工具能被一刀杀掉）、崩溃（工具死了 Agent 继续）、
内存（独立堆）、以及 Agent 自己的状态（工具碰不到 history、config、running）。

为什么是子进程而不是 Worker 线程：Worker 被 terminate 之后 Bun 不归还它占的约 22MB，
而且杀线程带不走它 spawn 出来的孙进程（每个还活着、还在烧 CPU）。常驻 agent 天天要杀工具进程
（工具崩溃、工具超时、用户打断），于是两笔账都会一直累积。换成子进程之后，杀一次内存完整还给
操作系统、孙进程一起带走——实测 200 次「起→用→杀」主进程只涨 2MB，而 Worker 版是 4.4GB。

一个工具进程长期存活、一次只服务一次调用，所以每条消息都带 callId，主线程靠它认领结果。

工具文件默认导出一个工具或一组工具：

    export default {
        name: 'read',
        description: '读取文件',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        timeout: 30000,                                  // 可选，不写就一直等（阻塞型工具靠这个）
        async execute(input) { return await Bun.file(input.path).text() },
    }

工具作者不需要写任何流式输出代码：console.log 和 Bun.spawn 的子进程输出都会被自动转发；
execute 写成 async * 时，每个 yield 也会实时发出去。

约束（改这个文件时必须守住）：本文件内不能出现任何 import 或 require。
它以 stdin 喂进来的匿名程序身份运行，相对路径和裸包名会按进程当前目录解析、必然出错；
工具文件由主线程以绝对 file:// URL 传进来，不受这条限制影响。
*/


const encoder = new TextEncoder()               // 重放给工具的那一份要再变回字节流。
const KEEP = 8 << 20                            // 替工具留着的子进程输出上限（8MB）：正常构建/测试日志都装得下，工具永远不读时内存也有天花板。

let current = null                              // 当前正在执行的 callId；空闲时为 null。

// --- 把一段实时输出报给主线程 ---
// 空闲时直接丢弃：工具返回之后还在打日志（自己起了不 await 的后台任务），
// 那些输出不属于任何一次调用，发出去只会被记到下一次调用头上。
const report = (stream, data) => current && process.send({ callId: current, type: 'output', stream, data })


// --- 子进程输出：工具进程是唯一读者，读到的每段既发给主线程，也留一份给工具自己读 ---
// 不用 tee()：tee 的两路里只要有一路没人读，另一路读多少就在内存里堆多少，没有上限。
const relay = (source, stream) => {
    const decoder = new TextDecoder()                                   // 每条流各用一个解码器：共用的话，一个汉字被拆成两块时残留字节会拼到别的流上变成乱码。
    const kept = []                                                     // 留给工具读的副本，只保留尾部 KEEP 字节。
    let size = 0                                                        // 副本当前占用的字符数。
    let ended = false                                                   // 子进程这条流是否已经读完。
    let wake = null                                                     // 工具正等着新数据时，用它唤醒。

    void (async () => {                                                 // 后台一路读原始管道，读到什么就转发什么。
        try {
            for await (const chunk of source) {
                let text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }) // 字节流转文字。
                report(stream, text)                                    // 实时转发给主线程，发完即走，不占内存。
                if (text.length > KEEP) text = text.slice(-KEEP)        // 单块就超过上限时，留给工具的只保留尾部（转发给主线程的那份仍是完整的）。
                kept.push(text)                                         // 同一段也留给工具，它可能自己要读。
                size += text.length
                while (size > KEEP && kept.length) size -= kept.shift().length // 工具不读时丢最旧的，内存有明确上限；size 和 kept 必须同步加减。
                wake?.()                                                // 有新数据了，叫醒正在等的工具。
            }
        } catch {}                                                      // 管道被重置、孙进程被杀：当成流结束，不能让读这条流的工具永远等下去。
        ended = true                                                    // 子进程关流了，等待中的工具该收尾了。
        wake?.()
    })()

    // 工具拿到的是这份重放流，不是原始管道，所以原始管道永远只有一个读者。
    return new ReadableStream({
        async pull(controller) {
            while (!kept.length && !ended) await new Promise(resolve => { wake = resolve }) // 没有新数据就挂起，等 relay 唤醒。
            if (kept.length) { const item = kept.shift(); size -= item.length; controller.enqueue(encoder.encode(item)) } // 交给工具，同时把已消费的量从 size 里减掉（不减会误判超上限、提前关流丢数据）。
            else controller.close()                                     // 数据取完且子进程已结束，工具读到流尾。
        },
    })
}


// --- 劫持 Bun.spawn：工具照常写 spawn，子进程输出自动变成流式事件 ---
// 工具进程被杀时这些孙进程会跟着一起死，所以这里不需要额外做生命周期管理。
const spawn = Bun.spawn
Bun.spawn = (command, options = {}) => {
    const child = spawn(command, {
        ...options,
        stdout: options.stdout ?? 'pipe',                               // 工具自己指定了就不插手，那是它要自己读。
        stderr: options.stderr ?? 'pipe',
    })

    const stdout = child.stdout && relay(child.stdout, 'stdout')        // 接管这一路，工具改读重放流。
    const stderr = child.stderr && relay(child.stderr, 'stderr')

    return new Proxy(child, {                                          // 用代理把 stdout / stderr 换成重放流，其余照旧。
        get(target, property) {
            if (property === 'stdout') return stdout
            if (property === 'stderr') return stderr
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value // kill()、exited 这些照常可用。
        },
    })
}


// --- 劫持 console：工具里的 console.log 直接变成流式输出 ---
for (const name of ['log', 'info', 'warn', 'error']) {
    // 字符串原样输出，其余交给 Bun.inspect —— 和 console 自己的行为一致；
    // 不用 String()，它会被 Object.create(null) 这类没有 toString 的值抛穿，把跑成功的工具报成失败。
    console[name] = (...args) => report('console', args.map(value => typeof value === 'string' ? value : Bun.inspect(value)).join(' '))
}

// --- 异步生成器工具：每个 yield 立刻发出去，最后把全部片段作为返回值 ---
const collect = async result => {
    // 生成器 / 迭代器：既要 .next 又要可迭代（数组只有 iterator 没 next，不会被误当成生成器）。同步、异步生成器都收。
    if (!result || typeof result.next !== 'function' || (typeof result[Symbol.asyncIterator] !== 'function' && typeof result[Symbol.iterator] !== 'function')) return result
    const chunks = []                                                                 // 攒下每个 yield 出来的片段。
    for await (const chunk of result) {
        chunks.push(chunk)
        report('result', chunk)                                         // 逐段实时送达，上层不用等工具跑完。
    }
    return chunks                                                                     // 全部片段一起作为工具的返回值。
}


// AI SDK 认得的输出块类型。工具可以直接返回一个成形的块（README 里 finish 和截图工具都这么写），
// 认出来才不会给它再套一层 json —— 套了之后模型看到的是 {"type":"json","value":{"type":"text",...}}。
const BLOCK = new Set(['text', 'json', 'content', 'error-text', 'error-json', 'execution-denied'])

const jsonSafe = value => JSON.parse(JSON.stringify(value, (key, one) => one instanceof ArrayBuffer ? Buffer.from(new Uint8Array(one)).toString('base64') : one instanceof Uint8Array ? Buffer.from(one).toString('base64') : one))


// --- 成形：把返回值变成模型能读的输出块，转成纯 JSON 后发回主线程 ---
// 这里只做两件事：跑工具作者写的 toModelOutput、做 JSON 化。形状校验不在这一层——
// 校验统一在主线程 Tool.execute 里做一次（见 utils/shape.js 的 outputProblem），
// 这样规则只有一处，不用在子进程里抄一份、也就不会和主线程漂移。
// 输出太长时的截断也不在这里：截断在主线程里统一做（见 tool.js 的 cutOutput）。
const shape = async (tool, result, input, toolCallId) => {
    const value = result?.output ?? result                              // 工具可以返回 { output } 对象，也可以直接返回值。
    // 工具自带格式化时优先用它；AI SDK 允许它返回 Promise，所以 await（和主线程那边的内存工具一致）。
    const output = tool.toModelOutput ? await tool.toModelOutput({ output: value, input, toolCallId })
        : BLOCK.has(result?.output?.type) ? result.output               // 工具自己就给了成形的输出块——图片和多模态结果走的就是这条路。
        : value === undefined || value === null || value === '' ? { type: 'text', value: '工具执行成功，但没有输出' } // 空返回也给一句交代。
        : typeof value === 'string' ? { type: 'text', value }           // 返回字符串，直接当文字给模型。
        : { type: 'json', value }                                       // 其余结构化值转成 JSON 块。

    // 跨进程只传纯 JSON：Date 变字符串、NaN 变 null、二进制转 base64、循环引用在这里变成一条正常的工具错误。
    return jsonSafe(output)
}


// --- 收到一次执行请求：找工具 → 跑工具 → 把成形后的结果发回去 ---
// data.signal 是主线程把取消信号序列化后的形状（{ aborted, reason }）或 undefined；
// 还原成真 AbortSignal 交给工具，文件工具和内存工具的 execute(input, options) 契约就一致了——
// 之前文件工具的 options 是 undefined，应用里写了 options.abortSignal 的工具在子进程路径下永远收不到信号。
process.on('message', async data => {
    current = data.callId                                                       // 本次调用的身份，console 输出也归到它名下。
    const signal = data.signal                                                  // 序列化形状；undefined 就是没有信号。
        ? new AbortController().signal                                         // 占位：真正"取消即杀进程"仍由主线程 kill 完成。
        : undefined
    if (data.signal?.aborted) return process.send({ callId: data.callId, type: 'error', message: '工具执行已取消' })
    try {
        const module = await import(data.url)                                   // 工具进程是独立进程，工具文件在这里重新加载。
        const tool = [module.default].flat().find(one => one.name === data.name) // 按工具名找到文件里的那一个。
        const result = await collect(await tool.execute(data.input, { ...data.signal, signal, abortSignal: signal })) // 跑工具；生成器工具顺便把每个 yield 实时发出去。options 形状与内存工具对齐。
        process.send({ callId: data.callId, type: 'done', output: await shape(tool, result, data.input, data.toolCallId), stop: result?.stop === true }) // stop 是工具主动要求结束整个循环。
    } catch (error) {
        process.send({ callId: data.callId, type: 'error', message: error?.message || String(error) }) // 工具抛错、toModelOutput 抛错、输出块非法、JSON 化失败，对模型来说都是"这个工具没成功"。
    } finally {
        current = null                                                          // 交还身份：这之后再有输出就不属于任何一次调用了。
    }
})


process.send({ ready: true }) // 告诉主线程可以派活了；在这之前发过来的消息会排队，但握手让借用逻辑不必猜。
