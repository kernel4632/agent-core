/*
盯住"任何模型都能用工具"这件事。

纯对话模型不认原生工具字段，只会说话。文字工具协议把工具说明写进 system、
从模型的文字里读回调用、把工具结果降级成文字再送回去。历史本身始终是标准形状，
所以下面每条测试最后都要确认：history 里是 tool-call / tool 消息，而不是一堆文字。
*/

import { expect, test, describe } from 'bun:test'
import Agent from '../index.js'
import TextTools from '../features/text-tools.js'
import { TOOLS, pairing } from './helpers.js'
import Context from '../features/context.js'

const chatReply = text => Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: {} })
const nativeCall = (name, args) => Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_native', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: {} })


describe('refused 判断接口是不是拒收了工具字段', () => {
    test('认 tools / function / tool_calls，但不误判普通词', () => {
        expect(TextTools.refused({ kind: 'request', message: 'tools is not supported' })).toBe(true)
        expect(TextTools.refused({ kind: 'request', message: 'tool_calls is not supported' })).toBe(true) // 下划线变体也要认。
        expect(TextTools.refused({ kind: 'request', message: 'context length exceeded' })).toBe(false)
        expect(TextTools.refused({ kind: 'server', message: 'internal server malfunction' })).toBe(false) // malfunction 里的 function 不能误伤。
    })
})

describe('从文字里读回工具调用', () => {
    const spec = { names: ['add', 'read_file'], params: { add: { a: 'number', b: 'number' }, read_file: { path: 'string' } } }

    test('标准 <tool_call> 块', () => {
        const parsed = TextTools.parse('我来算。\n<tool_call>\n{"name": "add", "arguments": {"a": 1, "b": 2}}\n</tool_call>', spec)
        expect(parsed.calls).toEqual([{ toolName: 'add', input: { a: 1, b: 2 } }])
        expect(parsed.text).toBe('我来算。') // 调用从文字里摘掉，只留说明文字。
    })

    test('一次回复里的多个调用', () => {
        const parsed = TextTools.parse('<tool_call>{"name":"add","arguments":{"a":1,"b":2}}</tool_call><tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call>', spec)
        expect(parsed.calls.map(one => one.toolName)).toEqual(['add', 'read_file'])
    })

    test('OpenAI 风格：arguments 是字符串、外面再套 function', () => {
        const parsed = TextTools.parse('<tool_call>{"type":"function","function":{"name":"add","arguments":"{\\"a\\":3,\\"b\\":4}"}}</tool_call>', spec)
        expect(parsed.calls[0]).toEqual({ toolName: 'add', input: { a: 3, b: 4 } })
    })

    test('参数平铺在同一层、带围栏、带尾逗号', () => {
        const parsed = TextTools.parse('<tool_call>\n```json\n{"name":"add","a":5,"b":6,}\n```\n</tool_call>', spec)
        expect(parsed.calls[0]).toEqual({ toolName: 'add', input: { a: 5, b: 6 } })
    })

    test('Roo Code / Cline 风格的 XML 标签，按 schema 把类型转回来', () => {
        const parsed = TextTools.parse('先读文件\n<read_file>\n<path>src/main.js</path>\n</read_file>\n<add><a>7</a><b>8</b></add>', spec)
        expect(parsed.calls).toEqual([{ toolName: 'read_file', input: { path: 'src/main.js' } }, { toolName: 'add', input: { a: 7, b: 8 } }]) // 7 和 8 是数字，不是字符串。
    })

    test('只有一个参数时，标签体本身就是参数值', () => {
        // 有的模型写成 <read_file>src/main.js</read_file>（不套子标签）。只有一个参数时这没有歧义。
        const parsed = TextTools.parse('<read_file>src/main.js</read_file>', spec)
        expect(parsed.calls[0]).toEqual({ toolName: 'read_file', input: { path: 'src/main.js' } })
    })

    test('没闭合的最后一块（被截断）仍然读得回来', () => {
        const parsed = TextTools.parse('<tool_call>\n{"name":"add","arguments":{"a":1,"b":1}}', spec)
        expect(parsed.calls[0].toolName).toBe('add')
    })

    test('无引号键 / 尾逗号这类不标准 JSON，交给 jsonrepair 读出来', () => {
        const parsed = TextTools.parse('<tool_call>{"name":"add","arguments":{a:1,}}</tool_call>', spec)
        expect(parsed.calls[0].input).toEqual({ a: 1 })   // 修好了，不是无效调用。
        expect(parsed.calls[0].invalid).toBeUndefined()
    })

    test('真读不出来的 JSON 变成 invalid 调用，让模型自己重来', () => {
        const parsed = TextTools.parse('<tool_call>{"name":"add"} oops</tool_call>', spec) // 后面跟了非 JSON 字符，修不回来。
        expect(parsed.calls[0].toolName).toBe('add')
        expect(parsed.calls[0].invalid).toBe(true)
    })

    test('模型自己编的 <tool_result> 及之后的内容全部丢掉', () => {
        const parsed = TextTools.parse('<tool_call>{"name":"add","arguments":{"a":1,"b":2}}</tool_call>\n<tool_result name="add">3</tool_result>\n结果是 3。', spec)
        expect(parsed.calls).toHaveLength(1)
        expect(parsed.text).toBe('') // 幻觉出来的结果和"结论"都不能进历史。
    })

    test('严格模式不把讲解用的代码块当成调用；宽松模式才认已注册的工具', () => {
        const text = '示例：\n```json\n{"name":"add","arguments":{"a":1,"b":2}}\n```'
        expect(TextTools.parse(text, spec).calls).toHaveLength(0)
        expect(TextTools.parse(text, spec, { loose: true }).calls).toHaveLength(1)
        expect(TextTools.parse('```json\n{"name":"rm_rf","arguments":{}}\n```', spec, { loose: true }).calls).toHaveLength(0) // 没注册的名字不认。
    })

    test('普通回答原样保留', () => {
        expect(TextTools.parse('你好，今天天气不错。', spec)).toEqual({ text: '你好，今天天气不错。', calls: [] })
    })
})


describe('出门降级：标准历史 → 纯对话消息', () => {
    test('tool-call 变成文字块，tool 结果变成 user 消息，相邻同角色合并', () => {
        const out = TextTools.downgrade([
            { role: 'user', content: '算一下' },
            { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'add', input: { a: 1, b: 2 } }] },
            { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'add', output: { type: 'json', value: 3 } }] },
            { role: 'user', content: '继续' },
        ])
        expect(out.map(one => one.role)).toEqual(['user', 'assistant', 'user']) // tool 结果和后面的 user 合成一条。
        expect(JSON.stringify(out)).not.toContain('tool-call')
        expect(JSON.stringify(out)).not.toContain('tool-result')
        expect(out[1].content[1].text).toContain('<tool_call>')
        expect(out[2].content[0].text).toContain('<tool_result name="add">\n3\n</tool_result>')
    })

    test('工具返回的图片保留成媒体块，纯对话模型支持看图就还能继续看', () => {
        const out = TextTools.downgrade([{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'shot', output: { type: 'content', value: [{ type: 'text', text: '截图' }, { type: 'file', mediaType: 'image/png', data: 'AAAA' }] } }] }])
        expect(out[0].content.some(part => part.type === 'file' && part.mediaType === 'image/png')).toBe(true)
    })

    test('wrap 把说明书接在已有 system 后面；没有 system 就新加一条', () => {
        const spec = { names: [], params: {}, instructions: '说明书' }
        expect(TextTools.wrap([{ role: 'system', content: '你是助手' }, { role: 'user', content: '你好' }], spec)[0]).toEqual({ role: 'system', content: '你是助手\n\n说明书' })
        expect(TextTools.wrap([{ role: 'user', content: '你好' }], spec).map(one => one.role)).toEqual(['system', 'user'])
    })

    test('read 把文字里的调用改写成原生调用的形状；已有原生调用时原样返回', () => {
        const spec = { names: ['add'], params: {}, instructions: '' }
        const reply = { text: '<tool_call>{"name":"add","arguments":{"a":1}}</tool_call>', toolCalls: [], responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: '原文' }] }] }
        const read = TextTools.read(reply, spec)
        expect(read.toolCalls[0]).toMatchObject({ type: 'tool-call', toolName: 'add', input: { a: 1 } })
        expect(read.responseMessages.at(-1).content.some(part => part.type === 'tool-call')).toBe(true) // 写进 history 的也是标准块。

        const native = { ...reply, toolCalls: [{ toolCallId: 'n1', toolName: 'add', input: {} }] }
        expect(TextTools.read(native, spec)).toBe(native)
    })
})


describe('三种 toolMode 跑完整的 Agent 循环', () => {
    // 一个纯对话的假模型：看见请求里有 tools 字段就 400（真实纯对话中转站就是这样），
    // 否则按收到的上下文决定说什么：还没有工具结果时发一个文字调用，有了结果就给最终回答。
    const plainChatModel = () => {
        const requests = []
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const body = await request.json()
                requests.push(body)
                if (body.tools) return Response.json({ error: { message: 'tools is not supported for this model' } }, { status: 400 })
                const last = JSON.stringify(body.messages.at(-1))
                if (last.includes('tool_result')) return chatReply('答案是 done:你好。')
                return chatReply('我来回显一下。\n<tool_call>\n{"name": "echo", "arguments": {"value": "你好"}}\n</tool_call>')
            },
        })
        return { server, requests }
    }

    test('text：不发 tools 字段，工具说明进 system，调用从文字读回、真的执行', async () => {
        const { server, requests } = plainChatModel()
        try {
            const tools = await Agent.tool.scan(TOOLS)
            const results = []
            const agent = Agent.create({ config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false, toolMode: 'text', noToolRounds: 1 }, tools, callbacks: { onToolResult: one => results.push(one) } }) // 这里测协议，不测追问，答完就结束。
            const answer = await agent.send('回显你好')

            expect(requests.every(body => !('tools' in body))).toBe(true)
            expect(requests[0].messages[0].content).toContain('<tool_call>')    // system 里教了格式。
            expect(requests[0].messages[0].content).toContain('echo')           // 也列了工具。
            expect(results[0].output).toEqual({ type: 'text', value: 'done:你好' }) // 工具真跑了。
            expect(answer).toMatchObject({ reason: 'no-tool', text: '答案是 done:你好。' })

            // 第二次请求里，上一轮的调用和结果是文字，没有 tool 角色——纯对话接口才收得下。
            expect(requests[1].messages.some(message => message.role === 'tool')).toBe(false)
            expect(JSON.stringify(requests[1].messages)).toContain('<tool_result name=\\"echo\\">')

            // 但历史本身是标准形状：换回原生模型也能直接接着用。
            expect(agent.history.map(one => one.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
            expect(agent.history[1].content.some(part => part.type === 'tool-call' && part.toolName === 'echo')).toBe(true)
            expect(agent.history[1].content.find(part => part.type === 'text').text).toBe('我来回显一下。')
            expect(pairing(Context.build({ history: agent.history }).messages).ok).toBe(true)
        } finally { server.stop(true) }
    })

    test('auto：接口拒收 tools 时自动降级成文字协议，并记住这个模型，之后不再撞墙', async () => {
        const { server, requests } = plainChatModel()
        try {
            const tools = await Agent.tool.scan(TOOLS)
            const agent = Agent.create({ config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'plain-auto', stream: false, toolMode: 'auto', noToolRounds: 1, retryBaseDelay: 20, retryMaxElapsed: 300 }, tools }) // 不关重试：默认"全重试"下工具被拒也必须立刻降级；若没把"工具被拒"并进过滤，这里会重试到 300ms 后抛错，断言失败。
            const answer = await agent.send('回显你好')

            expect(answer.text).toBe('答案是 done:你好。')
            expect('tools' in requests[0]).toBe(true)                        // 第一次照常试原生，
            expect(requests.slice(1).every(body => !('tools' in body))).toBe(true) // 被拒之后全走文字，第二轮也不再先撞一次。
            expect(requests).toHaveLength(3)                                  // 撞墙 1 次 + 调用 1 次 + 最终回答 1 次。
        } finally { server.stop(true) }
    })

    test('auto：和工具无关的 400（比如上下文超长）不会触发文字重发，也不会降级', async () => {
        // 上下文超长这类 400 和工具字段无关，改成文字协议也同样失败。所以只按原生失败一次，
        // 不浪费一次文字重发，更不能记住"这个模型不支持原生工具"（那样这个进程里之后就全被降级）。
        let calls = 0
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const body = await request.json()
                calls += 1
                if (calls <= 1) return Response.json({ error: { message: 'context length exceeded' } }, { status: 400 }) // 只有第一次失败，且信息里没有工具字样。
                return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'tools' in body ? '原生' : '文字' }, finish_reason: 'stop' }], usage: {} })
            },
        })
        try {
            const tools = await Agent.tool.scan(TOOLS)
            const agent = Agent.create({ config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'too-long-once', stream: false, toolMode: 'auto', retryMaxElapsed: 0 }, tools })
            await agent.send('第一次').catch(() => {})  // 原生失败，且不重发文字。
            const answer = await agent.send('第二次')

            expect(answer.text).toBe('原生') // 下一次仍然先试原生工具，没有被永久降级。
        } finally { server.stop(true) }
    })

    test('auto：模型支持原生工具，却把调用写成了文字，也能读回来执行', async () => {
        let round = 0
        const server = Bun.serve({ port: 0, async fetch(request) { await request.json(); round += 1; return round === 1 ? chatReply('<tool_call>{"name":"echo","arguments":{"value":"x"}}</tool_call>') : chatReply('完成') } })
        try {
            const tools = await Agent.tool.scan(TOOLS)
            const results = []
            const agent = Agent.create({ config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'leaky', stream: false, toolMode: 'auto' }, tools, callbacks: { onToolResult: one => results.push(one) } })
            await agent.send('回显 x')
            expect(results[0].output.value).toBe('done:x')
        } finally { server.stop(true) }
    })

    test('默认只走原生：文字里的调用当成普通回答，system 零注入', async () => {
        const requests = []
        const server = Bun.serve({ port: 0, async fetch(request) { requests.push(await request.json()); return chatReply('<tool_call>{"name":"echo","arguments":{"value":"x"}}</tool_call>') } })
        try {
            const tools = await Agent.tool.scan(TOOLS)
            const results = []
            const agent = Agent.create({ config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false, system: '你是助手。' }, tools, callbacks: { onToolResult: one => results.push(one) } }) // 不写 toolMode，默认 native。
            const answer = await agent.send('回显 x')
            expect(results).toHaveLength(0)                                   // 没有主动打开兼容开关，就不去猜模型文字里的调用。
            expect(answer.text).toContain('<tool_call>')                      // 那段文字就是普通回答。
            expect(requests[0].messages[0].content).toBe('你是助手。')          // 调用方给的 system 原样送出，没有被追加任何工具说明。
        } finally { server.stop(true) }
    })

    test('auto：原生工具正常的模型，行为和以前完全一样', async () => {
        let round = 0
        const requests = []
        const server = Bun.serve({ port: 0, async fetch(request) { requests.push(await request.json()); round += 1; return round === 1 ? nativeCall('echo', { value: 'y' }) : chatReply('好了') } })
        try {
            const tools = await Agent.tool.scan(TOOLS)
            const agent = Agent.create({ config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'native-ok', stream: false }, tools })
            const answer = await agent.send('回显 y')
            expect(answer.text).toBe('好了')
            expect(requests.every(body => 'tools' in body)).toBe(true)                 // 全程原生。
            expect(requests[0].messages[0].content ?? '').not.toContain('<tool_call>') // system 没被塞说明书。
        } finally { server.stop(true) }
    })
})
