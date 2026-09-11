import { expect, test, describe } from 'bun:test'
import Agent from '../index.js'
import History from '../utils/history.js'
import Context from '../features/context.js'
import Retry from '../utils/retry.js'
import Tool from '../features/tool.js'
import LLM from '../utils/llm.js'
import Compact from '../features/compact.js'
import Loop from '../features/loop.js'

const modelURL = 'http://127.0.0.1:39991/v1'

const server = Bun.serve({
    port: 39991,
    async fetch(request) {
        const body = await request.json()
        const lastMessage = body.messages.at(-1)
        const text = lastMessage?.content?.includes('需要压缩') ? '压缩后的内容' : '模型回答'
        if (body.stream) {
            const encoder = new TextEncoder()
            // 真实的 OpenAI 兼容服务一定会给出 finish_reason；少了它 AI SDK 会发一个 error 事件，
            // LLM.chat 就会按"供应商报错"抛出来（这正是它该做的），所以假服务器也必须发。
            const chunks = [
                `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text } }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
                'data: [DONE]\n\n',
            ]
            return new Response(new ReadableStream({
                start(controller) {
                    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
                    controller.close()
                },
            }), { headers: { 'Content-Type': 'text/event-stream' } })
        }
        const response = {
            id: 'test-response',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }
        return Response.json(response)
    },
})

describe('History and Context', () => {
    test('creates frontend history blocks with ids and AI SDK-like content', () => {
        const assistant = History.assistant({
            content: '我来处理',
            toolCalls: [{ id: 'call-1', name: 'echo', arguments: { value: 'hello' } }],
        })
        expect(assistant.id).toBeString()
        expect(assistant.role).toBe('assistant')
        expect(assistant.content[0]).toEqual({ type: 'text', text: '我来处理' })
        expect(assistant.content[1].input).toEqual({ value: 'hello' })

        // 这段历史里的 call-1 没有对应的工具结果（工具还没跑完）。
        // Context.build 会把这种没人应答的调用摘掉：带着它发请求的话，AI SDK 在本地就抛
        // MissingToolResultsError，一个字节都发不出去。正文照常保留。
        const context = Context.build({ history: [History.user({ content: '你好' }), assistant], system: '系统' })
        expect(context.messages).toEqual([
            { role: 'system', content: '系统' },
            { role: 'user', content: '你好' },
            { role: 'assistant', content: [{ type: 'text', text: '我来处理' }] },
        ])
        expect(context.token).toBeGreaterThan(0)
    })
})

describe('Retry', () => {
    test('returns a successful operation without retrying', async () => {
        let attempts = 0
        const result = await Retry.run({ operation: async () => { attempts += 1; return 'ok' } })
        expect(result).toBe('ok')
        expect(attempts).toBe(1)
    })

    test('rejects invalid retry options', async () => {
        expect(Retry.run({ operation: () => 'ok', maxDelay: -1 })).rejects.toThrow('maxDelay')
    })
})

describe('Tool and Worker', () => {
    test('scans tools and executes them in parallel with output events', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools')
        expect(tools.schema.echo).toBeDefined()
        expect(tools.handlers.echo.url).toBeDefined()

        const output = []
        const results = await Promise.all(['a', 'b'].map(value => Tool.execute({
            name: 'echo', input: { value }, handlers: tools.handlers,
            onOutput: event => output.push(event),
        })))

        expect(results.map(result => result.output.value)).toEqual(['done:a', 'done:b'])
        expect(output.map(event => event.data)).toContain('echo:a')
        expect(output.map(event => event.data)).toContain('echo:b')
    })

    test('keeps streamed tool output in the final result', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools')
        const output = []
        const result = await Tool.execute({ name: 'stream', input: {}, handlers: tools.handlers, onOutput: event => output.push(event) })
        expect(result.output.value).toEqual(['part-1', 'part-2'])
        expect(output.map(event => event.data)).toEqual(['part-1', 'part-2'])
    })
})

describe('LLM and Compact', () => {
    test('supports non-stream and stream LLM calls', async () => {
        const options = { baseURL: modelURL, apiKey: 'test', model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }
        const normal = await LLM.chat({ ...options, stream: false })
        expect(normal.text).toBe('模型回答')
        expect(normal.responseMessages).toBeArray()

        const events = []
        const streamed = await LLM.chat({ ...options, onLLMEvent: event => events.push(event) })
        expect(streamed.text).toBe('模型回答')
        expect(events.length).toBeGreaterThan(0)
    })

    test('compacts messages and reports lifecycle events', async () => {
        const events = []
        const content = await Compact.run({ messages: [{ role: 'user', content: 'long text' }], llm: { baseURL: modelURL, apiKey: 'test', model: 'test-model', protocol: 'chat' }, stream: false, onCompact: event => events.push(event) })
        expect(content).toBe('压缩后的内容')
        expect(events[0].type).toBe('compact-start')
        expect(events.at(-1)).toEqual({ type: 'compact-finish', content: '压缩后的内容' })
    })
})

describe('Loop and Agent', () => {
    test('runs the loop and stores the final assistant message in history', async () => {
        const history = [History.user({ content: '请回答我' })]
        const events = []
        const result = await Loop.run({
            history, system: '', tools: {}, llm: { baseURL: modelURL, apiKey: 'test', model: 'test-model' },
            buildContext: Context.build, compact: Compact.run, executeTool: async () => ({}),
        })
        expect(result.reason).toBe('no-tool')
        expect(history.some(message => message.role === 'assistant')).toBe(true)
    })

    test('creates independent agents and exposes scanned tools', async () => {
        const tools = await Agent.tool.scan('./tests/fixtures/tools')
        const first = Agent.create({ tools })
        const second = Agent.create()
        expect(first.tools).toBe(tools)
        expect(second.tools.schema).toEqual({})
    })
})

// 测试文件退出时关闭本地服务，避免测试开始前就把服务关掉。
process.on('exit', () => server.stop())
