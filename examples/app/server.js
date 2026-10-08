/* 这个文件管这个示例工程的全部接线：起 HTTP 服务、管多个会话、把每一环应用层要接的东西都接上。
   它是给"要拿这个包去写真实 agent 应用的人"看的：会话管理 / 持久化 / 流式 / 权限 / 观测 / 取消 / 生产设置 / 换真模型。

   运行（Bun 直接跑仓库源码，不需要 build）：
     bun examples/app/server.js

   默认离线：server 启动时会把 mock-model.js 里的假模型也起起来。
   换成真实模型只需设环境变量（三个都要）：
     BASE_URL=https://你的中转站/v1  API_KEY=sk-xxx  MODEL=gpt-4o-mini   bun examples/app/server.js
   可选：PROTOCOL（chat / responses / anthropic / gemini）、PORT、DATA_DIR、DENY_WRITE=1、TOOL_ROOT。
*/

import Agent from '../../index.js'
import { startMockModel } from './mock-model.js'
import * as store from './store.js'

const PORT = Number(process.env.PORT ?? 8787)

// --- 一、模型来源：设了 BASE_URL 就用真实模型，否则起本地假模型，保证离线能跑 ---
let mock = null
let model
if (process.env.BASE_URL) {
    model = {
        baseURL: process.env.BASE_URL,
        apiKey: process.env.API_KEY ?? '',
        model: process.env.MODEL ?? 'gpt-4o-mini',
        protocol: process.env.PROTOCOL ?? 'chat',
    }
    console.log(`[server] 使用真实模型：${model.baseURL} / ${model.model}`)
} else {
    mock = startMockModel()
    model = { baseURL: `${mock.url}/v1`, apiKey: 'mock-key', model: 'mock-model', protocol: 'chat' }
    console.log('[server] 未设 BASE_URL，使用本地假模型（离线可跑）')
}

// --- 二、工具来源：目录里的文件工具（子进程）+ 这里现写的内存工具（主进程），演示两种混用 ---
const notes = [] // 内存工具写在进程里的数据，重启就没了——需要留存的话是应用层自己的事。

const tools = await Agent.tool.from(
    new URL('./tools', import.meta.url), // 文件工具：now、read_file
    {
        write_note: { // 内存工具：直接写在代码里，主进程内执行。
            description: '把一条笔记写进会话的笔记区（这是一个写操作）',
            inputSchema: {
                type: 'object',
                properties: { note: { type: 'string', description: '要写入的笔记内容' } },
                required: ['note'],
            },
            async execute({ note }) {
                notes.push(note)
                return `已写入第 ${notes.length} 条笔记：${note}`
            },
        },
    },
)
console.log(`[server] 已注册工具：${Object.keys(tools.schema).join('、')}`)

// 哪些工具算"写操作"，过权限门时要单独问。放在应用层而不是工具对象上：
// 挂在工具对象上的额外字段会被 Tool.adopt 一起当成工具描述发给模型，把内部标记泄露出去。
const WRITE_TOOLS = new Set(['write_note'])

// --- 三、生产安全设置：每一条都在挡一种"跑久了才会出事"的情况 ---
const config = {
    ...model,
    stream: true,
    system: '你是一个可靠的助手。需要事实时先调用工具，不要凭空猜。写东西之前会经过权限确认。',
    maxToolOutput: 20000,     // 单个工具最多回多少字符：一个爱刷日志的工具否则能把上下文和内存撑爆。
    maxToolConcurrency: 4,    // 一轮里最多同时跑几个工具：防止一次并行开几十个子进程。
    requestTimeout: 60000,    // 单笔模型请求最多等 60 秒：卡死的上游不会把会话永远吊住。
    retryMaxElapsed: 120000,  // 模型持续失败最多再试 2 分钟：给瞬时故障留机会，又不无限重试。
    maxContextTokens: 32000,  // 上下文预算：接近时自动压缩，避免把上下文撑爆。
    compactThreshold: 0.8,    // 用到预算的 80% 时压一次。
    maxSteps: 12,             // 一次 send 最多问模型几轮：模型一直调工具停不下来时，这是最后一道保险。
    noToolRounds: 1,          // 模型一轮不调工具就结束；生产里可调大让它有机会补救一次。
}

// --- 四、会话管理：id → 会话（agent + 这一轮的 SSE 出口） ---
const sessions = new Map()

const broadcast = (session, event) => { for (const sink of session.sinks) sink(event) }

// 观测回调：全程用 console.log 打一行行可读日志，说明每个环节在什么时候发生。
const callbacksOf = session => ({
    onLLMStart: () => {
        session.llmStartedAt = Date.now()
        console.log(`[llm] 会话 ${session.id} 发起模型请求`)
    },
    onLLMFinish: result => {
        const ms = Date.now() - (session.llmStartedAt ?? Date.now())
        console.log(`[llm] 模型返回，耗时 ${ms}ms，usage=${JSON.stringify(result.usage ?? {})}`)
        broadcast(session, { type: 'llm', ms, usage: result.usage ?? {} })
    },
    onLLMEvent: event => {
        if (event.type !== 'text-delta') return
        const text = event.textDelta ?? event.text ?? event.delta ?? ''
        if (text) broadcast(session, { type: 'delta', text })
    },
    onToolCall: call => {
        session.toolStart.set(call.toolCallId, Date.now())
        console.log(`[tool] 开始调用 ${call.toolName}，参数 ${JSON.stringify(call.input ?? {})}`)
        broadcast(session, { type: 'tool_call', toolName: call.toolName, input: call.input })
    },
    onToolResult: result => {
        const ms = Date.now() - (session.toolStart.get(result.toolCallId) ?? Date.now())
        session.toolStart.delete(result.toolCallId)
        console.log(`[tool] ${result.toolName} 执行完，耗时 ${ms}ms，结果 ${JSON.stringify(result.output?.value ?? {}).slice(0, 120)}`)
        broadcast(session, { type: 'tool_result', toolName: result.toolName, ms })
    },
    onStep: step => {
        console.log(`[step] 第 ${step.step} 轮完成，落盘 history（${session.agent.history.length} 条）`)
        broadcast(session, { type: 'step', step: step.step })
        // 每轮结束就存：这正是"这一轮的工具结果已经写进 history"的安全点。
        // 落盘是应用层的事，包本身只持有内存里的 history。
        store.save(session.id, session.agent.history).catch(error => console.error('[store] 落盘失败：', error.message))
    },
    onCompact: event => {
        // onCompact 会跟着压缩过程发很多次事件，只挑开始和结束各记一行，别把日志刷爆。
        if (event.type === 'compact-start') console.log(`[compact] 开始压缩，待压缩 ${Array.isArray(event.messages) ? event.messages.length : '?'} 条消息`)
        if (event.type === 'compact-finish') console.log(`[compact] 压缩完成，总结 ${event.content?.length ?? 0} 字`)
        broadcast(session, { type: 'compact', phase: event.type })
    },
    onPermission: async permission => {
        const write = WRITE_TOOLS.has(permission.toolName)
        console.log(`[permission] 询问：${write ? '写操作' : '读操作'} ${permission.toolName}，参数 ${JSON.stringify(permission.input ?? {})}`)
        // 读操作直接放行；写操作默认放行（这是演示），设 DENY_WRITE=1 就能看到"拒绝"这条路。
        const allowed = write ? process.env.DENY_WRITE !== '1' : true
        console.log(`[permission] 决定：${allowed ? '允许' : '拒绝'} ${permission.toolName}`)
        broadcast(session, { type: 'permission', toolName: permission.toolName, allowed })
        return allowed
    },
})

const createSession = (id, history) => {
    const session = { id, sinks: new Set(), llmStartedAt: 0, toolStart: new Map() }
    session.agent = Agent.create({ id, history, config, tools, callbacks: callbacksOf(session) })
    sessions.set(id, session)
    return session
}

// 内存里没有就去磁盘找；找到说明这是重启后的老会话，历史照样接着用。
const getSession = async id => {
    if (sessions.has(id)) return sessions.get(id)
    const history = await store.load(id)
    if (!history) return null
    console.log(`[store] 从磁盘恢复会话 ${id}（${history.length} 条历史）`)
    return createSession(id, history)
}

// --- 五、错误分类：取消不是失败，各种模型错误也不该都报 500 ---
const errorKind = error => error?.kind ?? (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' ? 'aborted' : 'unknown')
const STATUS = { auth: 401, limit: 429, timeout: 504, server: 502, network: 502, request: 400 }

// --- 六、发消息的两种出口：默认 SSE 流式，Accept: application/json 或 ?stream=0 时返回 JSON ---
const streamChat = (session, message) => {
    const encoder = new TextEncoder()
    let sink = null
    let closed = false

    const body = new ReadableStream({
        start(controller) {
            sink = event => {
                if (closed) return
                try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) } catch { closed = true }
            }
            session.sinks.add(sink)

            session.agent.send(message).then(result => {
                sink({ type: 'done', reason: result.reason, text: result.text, steps: result.steps, usage: result.usage })
            }).catch(error => {
                const kind = errorKind(error)
                // 取消单独发一种事件，客户端据此知道"用户停了"，而不是"出错了"。
                sink(kind === 'aborted' ? { type: 'aborted', kind } : { type: 'error', kind, message: String(error?.message ?? error) })
            }).finally(async () => {
                session.sinks.delete(sink)
                closed = true
                try { controller.close() } catch {}
                await store.save(session.id, session.agent.history).catch(() => {})
            })
        },
        cancel() {
            closed = true
            if (sink) session.sinks.delete(sink)
        },
    })

    return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } })
}

const jsonChat = async (session, message) => {
    try {
        const result = await session.agent.send(message)
        await store.save(session.id, session.agent.history)
        return Response.json({ ok: true, reason: result.reason, text: result.text, steps: result.steps, usage: result.usage })
    } catch (error) {
        await store.save(session.id, session.agent.history).catch(() => {}) // 取消时也把用户这一句和已完成的工具结果留下。
        const kind = errorKind(error)
        // 取消不是失败：返回 200 + cancelled，让客户端区分"用户停了"和"服务出错"。
        if (kind === 'aborted') return Response.json({ ok: false, cancelled: true, kind })
        return Response.json({ ok: false, kind, error: String(error?.message ?? error) }, { status: STATUS[kind] ?? 500 })
    }
}

const safeJson = async request => { try { return await request.json() } catch { return null } }

// --- 七、HTTP 路由 ---
const server = Bun.serve({
    port: PORT,
    async fetch(request) {
        const url = new URL(request.url)
        const segments = url.pathname.split('/').filter(Boolean)

        try {
            if (request.method === 'GET' && url.pathname === '/healthz') return Response.json({ ok: true, sessions: sessions.size, mock: Boolean(mock) })
            if (segments[0] !== 'sessions') return Response.json({ error: 'not found' }, { status: 404 })

            // 建会话：可选 body { id } 用来恢复老会话。
            if (request.method === 'POST' && segments.length === 1) {
                const id = String((await safeJson(request))?.id ?? crypto.randomUUID())
                const existing = await getSession(id)
                if (existing) return Response.json({ id, resumed: true, messages: existing.agent.history.length })
                const session = await createSession(id, [])
                await store.save(id, session.agent.history)
                console.log(`[session] 新建会话 ${id}`)
                return Response.json({ id, resumed: false })
            }

            if (segments.length !== 3) return Response.json({ error: 'not found' }, { status: 404 })
            const id = decodeURIComponent(segments[1])
            const action = segments[2]
            const session = await getSession(id)
            if (!session) return Response.json({ error: 'session not found' }, { status: 404 })

            if (request.method === 'POST' && action === 'messages') {
                const body = await safeJson(request)
                const message = typeof body?.message === 'string' ? body.message.trim() : ''
                if (!message) return Response.json({ error: 'message must be a non-empty string' }, { status: 400 })
                const wantsJson = url.searchParams.get('stream') === '0' || (request.headers.get('accept') ?? '').includes('application/json')
                return wantsJson ? jsonChat(session, message) : streamChat(session, message)
            }

            if (request.method === 'POST' && action === 'stop') {
                const result = await session.agent.stop()
                console.log(`[session] ${id} 收到停止请求：${result.ok ? '已中断' : '当前没有在跑的任务'}`)
                return Response.json(result)
            }

            if (request.method === 'POST' && action === 'compact') {
                try {
                    const content = await session.agent.compact()
                    await store.save(id, session.agent.history)
                    return Response.json({ ok: true, summary: content })
                } catch (error) {
                    const kind = errorKind(error)
                    if (kind === 'aborted') return Response.json({ ok: false, cancelled: true, kind })
                    return Response.json({ ok: false, kind, error: String(error?.message ?? error) }, { status: STATUS[kind] ?? 500 })
                }
            }

            if (request.method === 'GET' && action === 'history') {
                return Response.json({ id, messages: session.agent.history, rendered: Agent.history.render(session.agent.history) })
            }

            return Response.json({ error: 'not found' }, { status: 404 })
        } catch (error) {
            // 到这里基本是代码 bug（参数已各自校验），按 500 报并打出堆栈。
            console.error('[server] 未预期的错误：', error)
            return Response.json({ error: String(error?.message ?? error) }, { status: 500 })
        }
    },
})

console.log(`[server] 监听 http://127.0.0.1:${server.port}`)
