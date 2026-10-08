/*
工具这个主体的全部操作都在这里：从目录里找出工具、接纳内存工具对象、执行工具、合并工具集合。

    // 积木 1：扫描工具目录，得到一份独立的工具集合
    const tools = await Tool.scan('./tools')
    // tools.schema   → 给 LLM 的 AI SDK 标准工具描述，直接放进 LLM.chat 的 tools
    // tools.handlers → 给执行器用的工具地址表，直接放进 Tool.execute 的 handlers

    // 积木 2：把内存工具对象归一化成同样的形状
    // 接受数组：[{ name, description, inputSchema, execute }, ...]
    // 接受 record：{ echo: { description, inputSchema, execute } }
    // 接受 AI SDK tool() 产物（有 inputSchema + execute 字段的对象）
    // 接受已经是 { schema, handlers } 的集合 → 原样通过
    const tools = Tool.adopt(mcpClient.tools())

    // 积木 3：执行工具（模型要调工具时调用）
    const result = await Tool.execute({
        name: 'finish',              // 要执行哪个工具
        input: { result: '任务完成' }, // 工具参数，直接传给工具的 execute
        handlers: tools.handlers,    // 工具地址表，用来找到 finish 在哪里
        signal: abortSignal,         // 触发即杀，工具瞬间死（文件工具）/ 透传（内存工具）
        onOutput: output => {},      // 工具产生一段输出时调用，调用方决定如何展示或转发
        limit: Infinity,             // 不设输出上限；需要保护上下文时由调用方主动设置
        concurrency: 8,              // 这一轮最多同时跑几个文件工具，超出的排队
    })
    // result = { output, stop }            工具正常结束
    // result = { output, error }           工具抛错了，错误也作为一条结果交给模型
    // result = { output, interrupted }     被 signal 取消

    // 积木 4：合并工具集合
    const all = Tool.merge(fileTools, remoteTools)

    // 积木 5：取子集（schema 和 handlers 一起筛，不会出现"看不见还能执行"的状态）
    const readOnly = Tool.pick(all, ['read', 'glob'])   // 只留这两个
    const noShell = Tool.omit(all, ['shell'])           // 去掉 shell，其余全留

工具集合里的条目有两种执行方式，execute 一处分开：
  文件工具   → handler 带 url，交给工具子进程（见 tool-process.js），排队、取消、超时都在这里管；
  内存工具   → handler 带 execute 函数，在主进程直接调，结果经过和文件工具一致的成形规则。

文件工具跑在独立的 bun 子进程里，所以工具碰不到 Agent 的任何状态，
死循环的工具也能被一刀杀掉——进程内的 await 永远做不到这一点。

为什么是子进程而不是 Worker 线程：Worker 被 terminate 之后 Bun 不归还它占的约 22MB，
而且杀线程带不走它 spawn 出来的孙进程。常驻 agent 天天要杀工具进程（工具崩溃、超时、用户打断），
两笔账会一直累积。换成子进程后实测 200 次「起→用→杀」主进程只涨 2MB（Worker 版是 4.4GB），
孙进程一起带走，而且主进程退出时工具进程全部跟着死，不留孤儿。

工具进程是一池、全进程共用，用完还池。一次调用独占一个工具进程，所以并发跑的两个工具
不会把 console 输出串到一起。取消只杀 signal 相同的那些——Loop 给同一轮所有并行工具的
本来就是同一个 signal，"取消"在语义上就是"这一轮全部取消"，别的 Agent 不会被连坐。

工具想要超时保护，自己在工具文件里写 timeout（毫秒）。这个包没有全局超时，
因为阻塞型工具（等 IM 消息、盯文件变化）是它支持的正常用法，全局超时会把这类工具全废掉。
*/

import { pathToFileURL, fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import PQueue from 'p-queue'
import toolProcessSource from './tool-process.js' with { type: 'text' }
import Notify from '../utils/notify.js'
import normalizeInputSchema from '../utils/schema.js'
import shape, { outputProblem } from '../utils/shape.js'

// 工具进程要用一个"能跑脚本的 bun"来启动。宿主自己通常就是，用它比在 PATH 上碰运气可靠：
// 不依赖环境变量，也不会和宿主用的 bun 版本不一致。
// 但宿主被 bun build --compile 成单可执行文件时，execPath 是那个 exe 自己，
// 拿它当解释器等于把整个 app 再跑一遍——实测确实会，而且看起来像是工具挂了，很难查。
// 所以只认"execPath 本身就是个 bun 可执行文件"这一种情况，认不出来就退回 PATH 上的 bun：
// 判反的代价不对称，退回去只是回到最普通的做法，判错了却会让 app 自我重入。
const runtime = /^bun(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : 'bun'

// 一池工具进程，全进程共用。不按工具集合分池：取消已经按 signal 精确到轮次了，
// 再按集合分池只会让每次 Tool.scan 都新建一池、旧池的空闲进程永远没人回收。
// 工具在忙时按各自的 signal 控制并发；空闲进程最多留 8 个，避免多个 Agent 跑完后长期占内存。
const pool = { live: new Set(), idle: [], busy: new Map(), limit: 8 }
const DEFAULT_CONCURRENCY = 8 // 一次调用没指定上限时用的并发数。和 pool.limit 是两个概念，只是数值恰好相同。
let sequence = 0

// 每次运行一个队列：p-queue 保证同一队列内同时最多跑 concurrency 个，超出的自己排队。
// 有 signal 的（Loop 的一轮）各用各的队列；没有 signal 的直接调用，按并发数各用各的队列——
// 不能共用一个再改它的 concurrency，那样两次并发调用会互相顶掉对方的上限。
const queues = new WeakMap()
const directs = new Map() // 并发数 → 那个并发数专用的队列。

const queueOf = (signal, concurrency) => {
    if (!signal) {
        const limit = concurrency ?? DEFAULT_CONCURRENCY
        let queue = directs.get(limit)
        if (!queue) { queue = new PQueue({ concurrency: limit }); directs.set(limit, queue) }
        return queue
    }
    let queue = queues.get(signal)
    if (!queue) { queue = new PQueue({ concurrency: Infinity }); queues.set(signal, queue) }
    queue.concurrency = concurrency ?? Infinity
    return queue
}


// --- 扫描工具目录，返回一份完全独立的工具集合 ---
//
//   Tool.scan('./tools')
//   Tool.scan(builtinDir, userDir)         后面的覆盖前面的同名工具
//   Tool.scan(new URL('./tools', import.meta.url))
//
const scan = async (...directories) => {
    const schema = Object.create(null)
    const handlers = Object.create(null)
    const files = []

    for (const directory of directories.flat()) {
        const cwd = directory instanceof URL ? fileURLToPath(directory) : String(directory)
        const found = []
        for await (const file of new Bun.Glob('**/*.{js,mjs,ts,mts}').scan({ cwd, absolute: true, onlyFiles: true })) if (!/\.d\.m?ts$/.test(file)) found.push(file)
        files.push(...found.sort())
    }

    for (const file of files) {
        const url = pathToFileURL(file).href
        const module = await import(url)

        for (const tool of [module.default].flat()) {
            if (!tool?.name || typeof tool.execute !== 'function') continue

            const { execute, toModelOutput, timeout, ...modelTool } = tool

            schema[tool.name] = {
                ...modelTool,
                inputSchema: normalizeInputSchema(tool.inputSchema),
            }

            handlers[tool.name] = { url, timeout }
        }
    }

    return { schema, handlers }
}


// --- 接纳内存工具对象，归一化成 { schema, handlers } ---
// 接受：
//   单个工具 { name, description, inputSchema, execute, toModelOutput?, timeout? }
//   数组   [{ name, ... }, ...]
//   record { toolName: { description, inputSchema, execute, ... } }（AI SDK / MCP toolset 形状）
//   已归一化的 { schema, handlers } → 原样通过
//   null / undefined → 空工具集
//
// inputSchema 三种写法都认：裸 JSON Schema、zod/valibot（~standard）、AI SDK jsonSchema()。
// 采纳 MCP 客户端的 tools() 直接传进来就能用——工具自带的 execute / toModelOutput 都按 AI SDK 的签名调用。
const adopt = (input) => {
    if (!input) return { schema: Object.create(null), handlers: Object.create(null) }

    // 目录只有 scan 会扫，adopt 不扫。传错了当场说清楚，而不是悄悄得到一份空工具表。
    if (typeof input === 'string' || input instanceof URL) throw new TypeError(`Tool.adopt 不接受路径；要扫描目录用 await Tool.from(${JSON.stringify(String(input))}) 或 Tool.scan(...)`)
    if (typeof input?.then === 'function') throw new TypeError('Tool.adopt 收到的是 Promise（多半是漏了 await）；用 await Tool.from(...) 或先 await 再传') // 否则 Promise 会被当普通对象、静默得到空工具表。
    if (typeof input !== 'object') throw new TypeError('Tool.adopt 只接受工具对象、工具数组或 record') // 数字 / 布尔 / 函数这类根本不是工具，别静默变空表。
    if (Array.isArray(input) && input.some(one => typeof one === 'string' || one instanceof URL)) throw new TypeError('Tool.adopt 的工具数组里不能放路径；要扫描多个目录用 await Tool.from(dir1, dir2) 或 Tool.scan(dir1, dir2)')

    // 已经是归一化集合：schema 和 handlers 都必须有，缺一个就是传错了。
    if (!Array.isArray(input) && typeof input === 'object' && ('schema' in input || 'handlers' in input)) {
        if (input.schema == null || input.handlers == null) throw new TypeError('工具集合必须同时带 schema 和 handlers')
        return input
    }

    // 直接给一个工具对象（{ name, execute }）就当成单元素数组，不要求调用方自己包一层。
    // 但单个对象必须有 name；AI SDK tool() 的产物天生没有 name，只能放进 record / 数组并补上名字。
    if (typeof input.execute === 'function' && !input.name) throw new TypeError('单个工具对象必须带 name；AI SDK tool() 产物本身没有 name，请用 record（{ 名字: tool }）或数组并补上 name')
    const list = typeof input.execute === 'function' ? [input] : input

    // 把 record 或数组都统一成条目列表
    const entries = Array.isArray(list)
        ? list.map(tool => [tool?.name, tool])                     // 数组：工具对象自带 name
        : Object.entries(list).map(([name, tool]) => [name, typeof tool === 'object' && tool ? { name, ...tool } : tool]) // record：名字从键来

    const schema = Object.create(null)
    const handlers = Object.create(null)
    const dropped = []
    const nameless = []

    for (const [name, tool] of entries) {
        if (!name) { nameless.push(tool); continue }                 // 数组里的工具没写 name：单独报，别和"缺 execute"混在一起。
        // 没有 execute 的条目（含字符串、数字这类根本不是工具的）一律报错，不静默丢掉——adopt 收的是显式传进来的工具。
        if (typeof tool?.execute !== 'function') { dropped.push(name); continue }

        const { execute, toModelOutput, timeout, ...modelTool } = tool

        schema[name] = {
            ...modelTool,
            name,
            inputSchema: normalizeInputSchema(tool.inputSchema),
        }

        handlers[name] = { execute, toModelOutput, timeout }
    }

    if (nameless.length) throw new TypeError('数组里的工具必须带 name（record 形式的名字从键来）')

    if (dropped.length) throw new TypeError(`工具 ${dropped.join('、')} 缺少 execute 函数；已有工具表用 merge/pick/omit 组合，不要拆成工具对象再喂回来；handlers[name] 不是 execute`)

    return { schema, handlers }
}


// --- 一行拿到工具集合：每个参数可以是目录、内存工具或已有集合，按顺序合并 ---
//   await Tool.from('./tools', mcpClient.tools(), { skill })
//   await Tool.from(['./builtin', './user'])      // 一组目录
// 字符串和 URL 当目录扫描，其余交给 adopt；Promise 会先等它。同名时后面的覆盖前面的。
const from = async (...sources) => {
    const sets = []
    for (const source of sources) {
        const value = await source
        // 数组：全是路径就当成一组目录分别扫，否则当成一个工具数组交给 adopt（它本来也收数组）。
        if (Array.isArray(value)) sets.push(...await Promise.all(value.every(one => typeof one === 'string' || one instanceof URL) ? value.map(one => scan(one)) : [adopt(value)]))
        else sets.push(typeof value === 'string' || value instanceof URL ? await scan(value) : adopt(value))
    }
    return merge(...sets)
}


// --- 一次调用的实时输出缓冲：有界 ---
// 攒着"已产出的内容"，中断/超时时还给模型。即使调用方没设 maxToolOutput（limit=Infinity），
// 这里也必须有个硬上限：一个边跑边刷日志、又长期不返回的工具，否则能把主进程内存吃光。
const MAX_BUFFER = 1 << 20 // 100 万字符，够模型看懂已产出的内容了。
const buffer = limit => {
    const cap = Number.isFinite(limit) ? limit : MAX_BUFFER
    const head = []
    const tail = []
    let headSize = 0
    let tailSize = 0
    let dropped = 0

    return {
        push(chunk) {
            if (headSize < cap * 0.7) { head.push(chunk); headSize += chunk.length; return }
            tail.push(chunk)
            tailSize += chunk.length
            while (tailSize > cap * 0.3) { const gone = tail.shift(); tailSize -= gone.length; dropped += gone.length }
        },
        text: () => dropped
            ? `${head.join('')}\n\n……[输出过长，中间省略 ${dropped} 个字符]……\n\n${tail.join('')}`
            : head.join('') + tail.join(''),
    }
}


// --- 一个工具进程空出来了：先还池，再让排队的人去借 ---
const release = child => {
    child.unref()
    pool.idle.push(child)
    if (pool.idle.length > pool.limit) {
        const extra = pool.idle.shift()
        pool.live.delete(extra)
        extra.kill()
    }
}


// --- 一个工具进程废了：它不能再被借出去 ---
const retire = child => {
    if (!pool.live.delete(child)) return
    pool.busy.delete(child)
    pool.idle = pool.idle.filter(one => one !== child)
}


// --- 开一个新工具进程 ---
const open = () => {
    let ready
    const waiting = new Promise(resolve => { ready = resolve })

    const child = Bun.spawn([runtime, '-'], {
        stdin: 'pipe',
        stdout: 'inherit',
        stderr: 'inherit',
        ipc(message) {
            if (message.ready) return ready(child)

            const call = pool.busy.get(child)
            if (call?.id !== message.callId) return

            if (message.type === 'output') {
                call.output.push(String(message.data))
                Notify.tell(call.onOutput, { toolName: call.name, stream: message.stream, data: message.data })
                return
            }

            pool.busy.delete(child)
            release(child)
            if (message.type === 'error') call.finish({ output: { type: 'error-text', value: `工具执行失败：${message.message}` }, error: message.message })
            else call.finish({ output: message.output, stop: message.stop })
        },
    })

    pool.live.add(child)
    child.stdin.write(toolProcessSource)
    child.stdin.end()

    child.exited.then(code => {
        ready(null)
        const call = pool.busy.get(child)
        retire(child)
        call?.finish({ output: { type: 'error-text', value: `工具执行失败：工具进程退出（代码 ${code}）` }, error: 'process-exited' })
    })

    return waiting
}


// --- 借一个工具进程 ---
const borrow = async () => {
    const free = pool.idle.pop()
    const child = free ? (free.ref(), free) : await open()
    if (!child) throw new Error('工具进程启动失败：进程在握手完成前就退出了')
    return child
}


// --- 截断 ---
const cutText = (text, limit) => {
    if (text.length <= limit) return text
    const tailSize = Math.floor(limit * 0.3) // limit 很小时可能算成 0；slice(-0) 会返回整段，所以要单独挡一下。
    return `${text.slice(0, Math.floor(limit * 0.7))}\n\n……[输出过长，中间省略 ${text.length - limit} 个字符。请缩小范围或分页重新获取]……\n\n${tailSize ? text.slice(-tailSize) : ''}`
}

const cutOutput = (output, limit) => {
    if (!Number.isFinite(limit)) return output
    if (output.type === 'content') return { ...output, value: output.value.map(part => part.type === 'text' ? { ...part, text: cutText(part.text ?? '', limit) } : part) }
    const text = typeof output.value === 'string' ? output.value : JSON.stringify(output.value) ?? String(output.value) // 无 value 的 json 块（JSON.stringify 返回 undefined）按空串处理，别让 .length 抛错。
    return text.length <= limit ? output : { type: 'text', value: cutText(text, limit) }
}


// --- 执行一个工具 ---
// handler.execute（内存工具）→ 主进程直接调；handler.url（文件工具）→ 工具子进程。
const execute = async ({ name, input, toolCallId, handlers, signal, onOutput, limit = Infinity, concurrency }) => {
    const handler = handlers?.[name]
    if (!handler?.execute && !handler?.url) throw new Error(`Tool ${name} was not found in handlers`)
    const result = handler.execute
        ? await inProcess({ name, input, toolCallId, handler, signal, onOutput, limit })
        : await runInSubprocess({ name, input, toolCallId, handler, signal, onOutput, limit, concurrency })
    // 形状校验只在这一处做（内存工具和文件工具都过这里）：非法块变成一条正常的工具失败，绝不写进只增不删的 history。
    const problem = outputProblem(result.output)
    if (problem) return { output: { type: 'error-text', value: problem }, error: problem }
    return { ...result, output: cutOutput(result.output, limit) }
}


// --- 在主进程里执行一个内存工具 ---
// 内存工具是普通函数，杀不掉，所以三件事都靠"不再等它"来做：
//   取消：外部 signal 一到就按"已中断"结算，不等工具收尾（工具不理 signal 也不会卡住 stop/send）。
//   超时：工具自己声明了 timeout 就到点按超时结算。
// 两种情况下都会把取消信号发给工具，让它有机会自己收手。
const INTERRUPTED = Symbol('interrupted')

const inProcess = async ({ name, input, toolCallId, handler, signal, onOutput, limit }) => {
    const controller = new AbortController()
    const stop = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const interrupted = { output: { type: 'error-text', value: '工具执行已中断' }, interrupted: true }
    let timer
    let onAbort
    let settled = false // 已按超时/取消结算后置 true：生成器循环据此停下，不再转发输出、也不空转一个不理会 signal 的生成器。
    try {
        if (signal?.aborted) return interrupted // 进来之前就已经取消了。

        // 跑工具：签名和 AI SDK 一致（execute(input, { abortSignal, ... })），并顺带给 signal 一个别名，
        // 兼容按我们早期文档写成 execute(input, { signal }) 的工具（@ai-sdk/mcp 读的是 abortSignal）。
        // 生成器工具（async *execute，同步的 function* 也行）和文件工具一样：每个 yield 实时发出去，全部片段一起作为返回值。
        // 注意：生成器要在两次 yield 之间 await 一下，否则它会占着事件循环不停转，连超时/取消都插不进来——那是工具自己的写法问题。
        const task = (async () => {
            const result = await handler.execute(input, { signal: stop, abortSignal: stop }) // 同步返回值也能被 await 接住。
            if (result && typeof result.next === 'function' && (typeof result[Symbol.asyncIterator] === 'function' || typeof result[Symbol.iterator] === 'function')) { // 生成器 / 迭代器：既要 .next 又要可迭代（数组只有 iterator 没 next，不会被误当成生成器）。
                const chunks = []
                for await (const chunk of result) { // for await 对同步生成器和异步生成器都适用。
                    if (settled) { try { await result.return?.() } catch {} break } // 已经结算就别再往下跑（不理会取消的生成器否则会一直转）。
                    chunks.push(chunk)
                    Notify.tell(onOutput, { toolName: name, stream: 'result', data: chunk }) // 逐段实时送达。
                }
                return chunks
            }
            return result
        })()
        void task.catch(() => {}) // 先结算（取消/超时）后，工具迟到失败别变成未处理的拒绝。

        const racers = [task]
        if (handler.timeout) racers.push(new Promise((_, reject) => { timer = setTimeout(() => { settled = true; reject(new Error(`工具执行超时（${handler.timeout}ms）`)); controller.abort() }, handler.timeout) }))
        if (signal) racers.push(new Promise(resolve => { onAbort = () => { settled = true; resolve(INTERRUPTED) }; signal.addEventListener('abort', onAbort, { once: true }) }))

        const raw = await Promise.race(racers)
        settled = true // 正常返回也算结算：下面 finally 里清定时器、摘监听。
        if (raw === INTERRUPTED) { controller.abort(); return interrupted } // 取消优先结算，工具稍后返回也不采纳。
        const output = await shape(handler, raw, input, toolCallId)
        return { output, stop: raw?.stop === true }
    } catch (error) {
        return { output: { type: 'error-text', value: `工具执行失败：${error?.message || String(error)}` }, error: error?.message || String(error) }
    } finally {
        clearTimeout(timer)
        if (onAbort) signal.removeEventListener('abort', onAbort)
    }
}


// --- 在工具进程里执行一个文件工具 ---
const runInSubprocess = ({ name, input, toolCallId, handler, signal, onOutput, limit, concurrency }) => {
    const call = { id: String(++sequence), name, signal, onOutput, output: buffer(limit), done: false }
    const queue = queueOf(signal, concurrency)

    return new Promise(resolve => {
        const interrupted = one => ({ output: { type: 'error-text', value: `${one.output.text()}\n工具执行已中断` }, interrupted: true })

        const stop = () => {
            for (const [child, running] of [...pool.busy]) {
                if (running.signal !== signal) continue
                retire(child)
                child.kill()
                running.finish(interrupted(running))
            }
            call.finish(interrupted(call))
        }

        call.finish = result => {
            if (call.done) return
            call.done = true
            clearTimeout(call.timer)
            signal?.removeEventListener('abort', stop)
            call.releaseSlot?.() // 告诉队列这次调用真的结束了，名额可以让给同批的下一个。
            resolve(result)
        }

        const start = child => {
            if (call.done) return release(child)
            pool.busy.set(child, call)

            if (handler.timeout) call.timer = setTimeout(() => {
                retire(child)
                child.kill()
                call.finish({ output: { type: 'error-text', value: `${call.output.text()}\n工具执行超时（${handler.timeout}ms）` }, error: 'timeout' })
            }, handler.timeout)

            try { child.send({ callId: call.id, url: handler.url, name, input, toolCallId }) }
            catch (error) {
                retire(child)
                call.finish({ output: { type: 'error-text', value: `工具执行失败：无法派发到工具进程（${error.message}）` }, error: error.message })
            }
        }

        signal?.addEventListener('abort', stop, { once: true })
        if (signal?.aborted) return stop()

        queue.add(async () => {
            let child
            try { child = await borrow() }
            catch (error) { return call.finish({ output: { type: 'error-text', value: `工具执行失败：工具进程启动失败（${error.message}）` }, error: error.message }) }
            if (call.done) return release(child)
            await new Promise(done => { call.releaseSlot = done; start(child) }) // 等这次调用结算，队列才知道可以让下一个上。
        })
    })
}


// --- 合并工具集合 ---
// null / undefined 直接跳过：合并本身是"有几个算几个"，逼调用方自己过滤空值是多余负担。
const merge = (...sets) => ({
    schema: Object.assign(Object.create(null), ...sets.map(set => set?.schema ?? {})),
    handlers: Object.assign(Object.create(null), ...sets.map(set => set?.handlers ?? {})),
})


// --- 取子集：pick 只保留、omit 只去掉 ---
// schema 和 handlers 必须用同一批名字一起筛。只筛一份会得到"模型看不见但还能执行"（或反过来）的
// 隐蔽状态，上层很难发现。返回新集合，原集合不动。
const subset = (set, keep) => {
    const schema = Object.create(null)
    const handlers = Object.create(null)
    for (const name of Object.keys(set?.schema ?? {})) if (keep(name)) schema[name] = set.schema[name]
    for (const name of Object.keys(set?.handlers ?? {})) if (keep(name)) handlers[name] = set.handlers[name]
    return { schema, handlers }
}

//   Tool.pick(tools, ['read', 'write'])   只留这两个工具
const pick = (set, names) => {
    const wanted = new Set(names ?? [])
    return subset(set, name => wanted.has(name))
}

//   Tool.omit(tools, ['shell'])           去掉 shell，其余全留
const omit = (set, names) => {
    const dropped = new Set(names ?? [])
    return subset(set, name => !dropped.has(name))
}

export default { from, scan, adopt, execute, merge, pick, omit }
