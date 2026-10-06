/*
结构化结果从包内 schema 定义，到 HTTP 请求，再到 send 返回值的完整测试。
调用：bun test tests/output.test.js。流式和非流式使用同一份本地服务。

要固定格式的结果时，格式写在配置顶层的 output 里（它回答"要什么形状的结果"），
底层会并进 provider 交给 AI SDK，调用方不用关心这一步。
*/
import { test, expect } from 'bun:test'
import Agent from '../index.js'

// 一份常用的对象格式：{ total: number }。多处复用，避免每条用例各写一遍。
const total = Agent.output.object({ schema: Agent.schema.object({ total: Agent.schema.number() }) })

// --- 模拟最终对象，也能先要求执行一个真实文件工具 ---
const service = (text, withTool = false) => {
    const bodies = []
    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            const body = await request.json()
            bodies.push(body)
            const tool = withTool && bodies.length === 1
            const message = tool
                ? { role: 'assistant', content: null, tool_calls: [{ id: 'lookup', type: 'function', function: { name: 'echo', arguments: '{"value":"data"}' } }] }
                : { role: 'assistant', content: text }
            const finish_reason = tool ? 'tool_calls' : 'stop'
            if (!body.stream) return Response.json({ choices: [{ index: 0, message, finish_reason }], usage: {} })
            return new Response([
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: tool ? { tool_calls: message.tool_calls.map(call => ({ ...call, index: 0 })) } : message }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason }], usage: {} })}\n\n`,
                'data: [DONE]\n\n',
            ].join(''), { headers: { 'Content-Type': 'text/event-stream' } })
        },
    })
    return { server, bodies, config: { baseURL: `http://127.0.0.1:${server.port}/v1`, model: 'test' } }
}

for (const stream of [false, true]) {
    test(`数组输出，格式写在配置顶层（stream=${stream}）`, async () => {
        const { server, config } = service('{"elements":[{"name":"A"},{"name":"B"}]}')
        try {
            const agent = Agent.create({ config: { ...config, stream, output: Agent.output.array({ element: Agent.schema.object({ name: Agent.schema.string() }) }) } })
            expect((await agent.send('列出名字')).output).toEqual([{ name: 'A' }, { name: 'B' }])
        } finally { server.stop(true) }
    })

    test(`对象输出直接返回校验过的数据（stream=${stream}）`, async () => {
        const { server, bodies, config } = service('{"total":42}')
        try {
            const agent = Agent.create({ config: { ...config, stream, output: total } })
            const result = await agent.send('计算总数')
            expect(result.output).toEqual({ total: 42 })
            expect(result.text).toBe('{"total":42}')
            expect(bodies).toHaveLength(1)
            expect(bodies[0].response_format.type).toBe('json_schema') // 格式确实随请求发给了服务端。
        } finally { server.stop(true) }
    })

    test(`工具轮不要求最终 JSON，工具完成后返回对象（stream=${stream}）`, async () => {
        const { server, bodies, config } = service('{"total":42}', true)
        try {
            const tools = await Agent.tool.scan(new URL('./fixtures/tools', import.meta.url))
            const agent = Agent.create({ tools, config: { ...config, stream, output: total } })
            const result = await agent.send('先查工具再给出总数')
            expect(result.output.total).toBe(42)
            expect(bodies).toHaveLength(2)
            expect(agent.history.some(message => message.role === 'tool')).toBe(true)
        } finally { server.stop(true) }
    })

    test(`格式错误也会重试，模型重新生成后成功（stream=${stream}）`, async () => {
        // 新规则：格式错误默认也重试（模型重新生成不保证还是坏的）。
        // 第一次给一段校验不过的 JSON，第二次给正确对象，断言重试真的发生了。
        const bodies = []
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const body = await request.json()
                bodies.push(body)
                const content = bodies.length === 1 ? '{"total":"not a number"}' : '{"total":42}'
                const message = { role: 'assistant', content }
                if (!body.stream) return Response.json({ choices: [{ index: 0, message, finish_reason: 'stop' }], usage: {} })
                return new Response([
                    `data: ${JSON.stringify({ choices: [{ index: 0, delta: message }] })}\n\n`,
                    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {} })}\n\n`,
                    'data: [DONE]\n\n',
                ].join(''), { headers: { 'Content-Type': 'text/event-stream' } })
            },
        })
        try {
            const agent = Agent.create({ config: { baseURL: `http://127.0.0.1:${server.port}/v1`, model: 'test', stream, output: total, retryBaseDelay: 1 } })
            const result = await agent.send('计算')
            expect(result.output).toEqual({ total: 42 })
            expect(bodies).toHaveLength(2) // 第一份格式不合法，重试一次后成功。
        } finally { server.stop(true) }
    })
}

test('压缩不继承任务的结构化输出格式', async () => {
    const { server, bodies, config } = service('普通总结')
    try {
        const agent = Agent.create({ history: [{ role: 'user', content: '之前的任务' }], config: { ...config, stream: false, output: total } })
        expect(await agent.compact()).toBe('普通总结')
        expect(bodies[0].response_format).toBeUndefined() // 总结是自由文本，不带任务的格式。
        expect(agent.config.output).toBeDefined()          // 压缩本次覆盖不污染任务配置。
    } finally { server.stop(true) }
})
