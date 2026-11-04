/* 这个文件管一个假的 OpenAI 兼容模型，让整个示例离线可跑。
   它在 /v1/chat/completions 上按脚本回话，专门演示"多轮工具调用"：
     第 1 轮：调 now
     第 2 轮：如果用户提到读文件，调 read_file
     第 3 轮：如果用户提到写东西，调 write_note（这个工具会过权限门）
     最后   ：调 finish 收尾（它返回 stop: true，Agent 立刻结束，不用等 noToolRounds 追问）
   假模型只认关键字，不真懂语义，目的是把每一步都稳定走一遍。

   想换成真实模型：不用改这里，给 server.js 设三个环境变量即可——
     BASE_URL=https://你的中转站/v1  API_KEY=sk-xxx  MODEL=gpt-4o-mini
   只设了 BASE_URL 时，server.js 就不会启动这个假模型。 */

const encoder = new TextEncoder()

// 把消息的 content（字符串或内容块数组）摊成一段文字，用来找关键字。
const readText = content => Array.isArray(content)
    ? content.filter(part => part?.type === 'text').map(part => part.text).join(' ')
    : String(content ?? '')

// 看看已经跑过哪些工具。
// 注意：Agent 内部存的是内容块（tool-result / tool-call），但发给模型的线上格式已经换成
// OpenAI 的 { role:'tool', tool_call_id } 和 assistant.tool_calls，所以两种形状都要认。
const ranTools = messages => {
    const ran = new Set()
    const nameById = new Map()
    for (const message of messages) {
        if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) nameById.set(call.id, call.function?.name)
        if (Array.isArray(message.content)) for (const part of message.content) {
            if (part?.type === 'tool-result' && part.toolName) ran.add(part.toolName)
            if (part?.type === 'tool-call' && part.toolName) nameById.set(part.toolCallId, part.toolName)
        }
        if (message.role === 'tool') {
            const name = nameById.get(message.tool_call_id) ?? message.name
            if (name) ran.add(name)
        }
    }
    return ran
}

// 决定这一轮假模型要做什么：调某个工具，还是回文字。
const nextMove = messages => {
    const text = messages.filter(message => message.role === 'user').map(message => readText(message.content)).join('\n')
    const ran = ranTools(messages)
    const wantsRead = /read|file|读|文件|看/i.test(text)
    const wantsWrite = /write|note|save|写|记|保存|笔记/i.test(text)
    const file = (text.match(/[\w./-]+\.(?:md|json|js|ts|txt|mjs)/i) || [])[0] || 'README.md'
    const slow = /slow|慢/i.test(text) // message 里带 slow 就拖慢回复，用来演示"取消一个正在跑的请求"。
    const status = text.match(/\[status:(\d{3})\]/) // 带 [status:500] 时直接回这个错误码，用来演示应用的错误处理。
    if (status) return { status: Number(status[1]) }

    if (!ran.has('now')) return { tool: 'now', args: {}, slow }
    if (wantsRead && !ran.has('read_file')) return { tool: 'read_file', args: { path: file }, slow }
    if (wantsWrite && !ran.has('write_note')) return { tool: 'write_note', args: { note: `关于 ${file} 的自动笔记` }, slow }
    // 该做的都做完了：调用 finish 收尾（它返回 stop: true）。顺带带一句话，免得界面上只剩一个工具卡片。
    return { tool: 'finish', args: { summary: `任务完成。本轮依次调用了：${[...ran].join('、') || '（无）'}。` }, text: '任务完成。', slow }
}

const chunk = (model, delta, finishReason = null, usage) => ({
    id: 'mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
})

// 把一串事件按 SSE 逐条写出去，中间停一下，让"流式"看得见。slow 时拖得更久，方便演示取消。
const sse = (model, events, delay) => new Response(new ReadableStream({
    async start(controller) {
        for (const event of events) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            await Bun.sleep(delay)
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
    },
}), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } })

const reply = model => async move => {
    const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
    const delay = move.slow ? 350 : 20
    if (move.slow) await Bun.sleep(1200) // 先憋一会儿，给"停止"留出够用的时间窗。

    if (move.tool) {
        return sse(model, [
            chunk(model, { role: 'assistant', content: move.text ?? '' }), // 带说明文字时先发出来，和工具调用同属一条回复。
            chunk(model, { tool_calls: [{ index: 0, id: `call_${move.tool}`, type: 'function', function: { name: move.tool, arguments: JSON.stringify(move.args) } }] }),
            chunk(model, {}, 'tool_calls', usage),
        ], delay)
    }

    const pieces = move.text.match(/.{1,6}/gs) ?? [move.text]
    return sse(model, [
        chunk(model, { role: 'assistant', content: '' }),
        ...pieces.map(piece => chunk(model, { content: piece })),
        chunk(model, {}, 'stop', usage),
    ], delay)
}

// 非流式：同一套动作，换成一次性 JSON，方便别人用 stream:false 试。
const replyOnce = model => async move => {
    if (move.slow) await Bun.sleep(1200)
    return Response.json({
        id: 'mock', object: 'chat.completion', model,
        choices: [{
            index: 0,
            message: move.tool
                ? { role: 'assistant', content: move.text ?? null, tool_calls: [{ id: `call_${move.tool}`, type: 'function', function: { name: move.tool, arguments: JSON.stringify(move.args) } }] }
                : { role: 'assistant', content: move.text },
            finish_reason: move.tool ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    })
}

export const startMockModel = ({ port = 0 } = {}) => {
    const server = Bun.serve({
        port,
        async fetch(request) {
            const { pathname } = new URL(request.url)
            if (request.method !== 'POST' || !pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })

            const body = await request.json()
            const model = body.model || 'mock-model'
            // 压缩请求不带 tools 字段，这时直接回一段文字当总结；只有带工具的正常对话才走脚本。
            const hasTools = Array.isArray(body.tools) && body.tools.length > 0
            const move = hasTools
                ? nextMove(body.messages ?? [])
                : { text: '这是上下文总结：用户让读取文件并写了一条笔记，工具都执行完了。' }
            if (move.status) {
                console.log(`[mock-model] 按脚本返回错误码 ${move.status}`)
                return new Response(JSON.stringify({ error: { message: `mock error ${move.status}`, type: 'mock_error' } }), { status: move.status, headers: { 'Content-Type': 'application/json' } })
            }
            console.log(`[mock-model] ${move.tool ? `决定调用工具 ${move.tool}` : '决定直接回文字'}`)
            return await (body.stream ? reply(model)(move) : replyOnce(model)(move))
        },
    })

    const url = `http://127.0.0.1:${server.port}`
    console.log(`[mock-model] 假模型已启动：${url}/v1/chat/completions`)
    return { server, url, port: server.port, stop: () => server.stop(true) }
}
