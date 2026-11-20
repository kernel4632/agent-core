/*
主循环的端到端测试：宿主可改的状态下一轮生效、三种结束原因、并行工具按调用顺序写回、权限、
流式片段、上下文超长重发、自动 / 手动压缩、比例按模型名记账、文字工具开关。全部用假模型，没有网络。
*/

import { describe, expect, test } from 'bun:test'
import { APICallError } from 'ai'
import { Agent } from '../index.ts'
import type { Message } from '../index.ts'
import { script, tools, tool, toolNames } from './helpers.ts'

// history 里所有工具结果，按出现顺序。
const results = (history: Message[]) => history.flatMap(message => message.role === 'tool' ? (message.content as any[]) : [])

describe('结束原因', () => {
    test('没有工具时一次回答就是 finished', async () => {
        const { model } = script([{ text: '你好' }])
        const answer = await Agent.create({ model, stream: false }).send('hi')
        expect(answer.reason).toBe('finished')
        expect(answer.text).toBe('你好')
    })

    test('连续 noToolRounds 轮不调工具：第 N-1 轮后挂临时提醒（不进 history），第 N 轮结束为 no-tool', async () => {
        const dir = tools({ 'a.ts': tool('a', 'return 1') })
        const { model, calls } = script([{ text: '一' }, { text: '二' }, { text: '三' }])
        const agent = Agent.create({ model, tools: [dir], stream: false, noToolPrompt: '请用工具' })
        const answer = await agent.send('hi')
        expect(answer.reason).toBe('no-tool')
        expect(calls.length).toBe(3)
        expect(JSON.stringify(calls[2].prompt)).toContain('请用工具')        // 第三次请求带着提醒
        expect(JSON.stringify(calls[1].prompt)).not.toContain('请用工具')
        expect(JSON.stringify(agent.history)).not.toContain('请用工具')    // 提醒从不写进 history
    })

    test('工具返回 { stop: true } 时结束为 tool-stop', async () => {
        const dir = tools({ 'end.ts': tool('end', "return { output: '完成', stop: true }") })
        const { model } = script([{ calls: [{ name: 'end' }] }, { text: '不该走到这里' }])
        const agent = Agent.create({ model, tools: [dir], stream: false })
        expect((await agent.send('hi')).reason).toBe('tool-stop')
        expect(results(agent.history)[0].output).toEqual({ type: 'text', value: '完成' })
    })
})

describe('宿主改状态，下一轮生效', () => {
    test('运行中增删工具路径：下一次请求的工具表立即变化', async () => {
        const one = tools({ 'a.ts': tool('a', 'return 1') })
        const two = tools({ 'b.ts': tool('b', 'return 2') })
        const { model, calls } = script([{ calls: [{ name: 'a' }] }, { calls: [{ name: 'b' }] }, { text: '好了' }])
        const agent: Agent = Agent.create({ model, tools: [one], stream: false, noToolRounds: 1 })
        await agent.send('hi', { onEvent: event => { if (event.type === 'step' && event.step === 1) agent.tools = [two] } }) // 关掉插件 one，打开插件 two
        expect(toolNames(calls[0])).toEqual(['a'])
        expect(toolNames(calls[1])).toEqual(['b'])
        expect(results(agent.history).map(part => part.output.value)).toEqual([1, 2])
    })

    test('运行中换模型、改 system、往 history 里加消息：下一轮请求就用新值', async () => {
        const dir = tools({ 'a.ts': tool('a', 'return 1') })
        const first = script([{ calls: [{ name: 'a' }] }])
        const second = script([{ text: '换过了' }])
        const agent: Agent = Agent.create({ model: first.model, tools: [dir], stream: false, system: '旧提示' })
        const answer = await agent.send('hi', {
            onEvent: event => {
                if (event.type !== 'step') return
                agent.config = { ...agent.config, model: second.model, system: '新提示' }
                agent.history.push({ id: 'host', role: 'user', content: '宿主补充的一句' })
            },
        })
        expect(answer.text).toBe('换过了')
        expect(first.calls.length).toBe(1)
        const prompt = JSON.stringify(second.calls[0].prompt)
        expect(prompt).toContain('新提示')
        expect(prompt).toContain('宿主补充的一句')
    })
})

describe('工具执行', () => {
    test('一轮多个调用全部并行，结果按调用顺序写回', async () => {
        const dir = tools({ 'slow.ts': tool('slow', 'await Bun.sleep(400); return "慢"'), 'fast.ts': tool('fast', 'return "快"') })
        const { model } = script([{ calls: [{ name: 'slow', id: 's' }, { name: 'fast', id: 'f' }, { name: 'slow', id: 's2' }] }, { text: '完' }])
        const agent = Agent.create({ model, tools: [dir], stream: false, noToolRounds: 1 })
        const started = Date.now()
        await agent.send('hi')
        expect(Date.now() - started).toBeLessThan(1500)                   // 两个 400ms 的调用是并行的
        expect(results(agent.history).map(part => part.toolCallId)).toEqual(['s', 'f', 's2'])
    })

    test('onPermission 不返回 true 就写拒绝结果，工具不执行', async () => {
        const dir = tools({ 'a.ts': tool('a', 'return 1') })
        const { model } = script([{ calls: [{ name: 'a' }] }, { text: '好' }])
        const agent = Agent.create({ model, tools: [dir], stream: false, noToolRounds: 1 })
        await agent.send('hi', { onPermission: call => call.toolName !== 'a' })
        expect(results(agent.history)[0].output.type).toBe('execution-denied')
    })

    test('模型调用不存在的工具：写 error 结果交给模型', async () => {
        const { model } = script([{ calls: [{ name: 'ghost' }] }, { text: '好' }])
        const dir = tools({ 'a.ts': tool('a', 'return 1') })
        const agent = Agent.create({ model, tools: [dir], stream: false, noToolRounds: 1 })
        await agent.send('hi')
        expect(results(agent.history)[0].output.type).toBe('error-text')
    })

    test('流式：工具调用边写边冒出来，各事件按真实顺序各发一次，返回值与事件一致', async () => {
        const dir = tools({ 'a.ts': tool('a', 'return 1') })
        const { model } = script([{ calls: [{ name: 'a', id: 'c1', input: { x: 1 } }] }, { text: '好的' }])
        const types: string[] = []
        const events: any[] = []
        let text = ''
        const answer = await Agent.create({ model, tools: [dir], noToolRounds: 1 }).send('hi', { onEvent: event => { types.push(event.type); events.push(event); if (event.type === 'text') text += event.text } })
        const first = types.slice(0, types.indexOf('step') + 1)
        // 调用在请求进行中就冒出来（request-end 之前）；放行后 tool-run 是另一件事：马上执行
        expect(first).toEqual(['message', 'request-start', 'tool-input-start', 'tool-input', 'tool-input', 'tool-call', 'request-end', 'message', 'tool-run', 'message', 'tool-result', 'step'])
        expect(events.filter(event => event.type === 'tool-input').map(event => event.delta).join('')).toBe('{"x":1}')
        expect(events.find(event => event.type === 'tool-call').call).toEqual({ toolCallId: 'c1', toolName: 'a', input: { x: 1 } })
        expect(events.find(event => event.type === 'tool-run')).toMatchObject({ toolCallId: 'c1', toolName: 'a', path: expect.stringContaining('a.ts') })
        expect(types.filter(type => type === 'request-start')).toHaveLength(2)
        expect(types.filter(type => type === 'request-end')).toHaveLength(2)
        expect(types.at(-1)).toBe('step')
        expect(text).toBe(answer.text)
    })

    test('非流式：调用在 request-end 之前补发一次 tool-call；拒绝的调用没有 tool-run；无效调用照样冒出来', async () => {
        const dir = tools({ 'a.ts': tool('a', 'return 1') })
        const { model } = script([{ calls: [{ name: 'a', id: 'ok' }, { name: 'a', id: 'no' }, { name: 'ghost', id: 'bad' }] }, { text: '好' }])
        const types: string[] = []
        const events: any[] = []
        await Agent.create({ model, tools: [dir], stream: false, noToolRounds: 1 }).send('hi', { onPermission: call => call.toolCallId === 'ok', onEvent: event => { events.push(event); types.push(event.type) } })
        expect(types.slice(0, types.indexOf('step') + 1)).toEqual(['message', 'request-start', 'tool-call', 'tool-call', 'tool-call', 'request-end', 'message', 'tool-run', 'message', 'tool-result', 'message', 'tool-result', 'message', 'tool-result', 'step'])
        expect(events.filter(event => event.type === 'tool-run').map(event => event.toolCallId)).toEqual(['ok'])
        expect(events.find(event => event.type === 'tool-call' && event.call.toolCallId === 'bad').call.invalid).toBeString()
    })

    test('非流式也有 request-start / request-end：每次请求恰好一对，字段和 history 里的请求记录一致', async () => {
        const { model } = script([{ text: '好' }])
        const events: any[] = []
        const agent = Agent.create({ model, stream: false })
        await agent.send('hi', { onEvent: event => { events.push(event) } })
        expect(events.map(event => event.type)).toEqual(['message', 'request-start', 'request-end', 'message', 'step'])
        expect(events[1]).toMatchObject({ model: 'mock-model', attempt: 1 })
        expect(events[2].request).toEqual((agent.history.at(-1) as any).request)
        expect(events[1].start).toBe(events[2].request.start)
        expect(events[0].message).toMatchObject({ role: 'user', content: 'hi' })
        expect(events[0].message.id).toBe(agent.history[0].id)
        expect(events[3].message).toBe(agent.history.at(-1))
        expect(JSON.parse(JSON.stringify(events.slice(1, 3)))).toEqual(events.slice(1, 3))            // 纯数据，可原样经 SSE 转发
    })
})

describe('模型错误', () => {
    const error = (statusCode: number, message: string) => new APICallError({ message, url: 'http://x', requestBodyValues: {}, statusCode, responseBody: message })

    test('5xx 按配置重试：每次尝试一个 request-start，失败的带 retry 收尾；maxTries 用尽后最后一条不带 retry，抛带 kind 的错误', async () => {
        let fails = 2
        const { model } = script([() => { if (fails-- > 0) throw error(503, '忙'); return { text: '好' } }])
        const events: any[] = []
        const answer = await Agent.create({ model, stream: false, retryBaseDelay: 0 }).send('hi', { onEvent: event => { events.push(event) } })
        expect(answer.text).toBe('好')
        expect(events.map(event => `${event.type}:${event.attempt ?? ''}`)).toEqual(['message:', 'request-start:1', 'message:', 'request-error:1', 'request-start:2', 'request-error:2', 'request-start:3', 'request-end:', 'message:', 'step:'])
        expect(events[3]).toMatchObject({ error: { kind: 'server', statusCode: 503 }, retry: { delay: 0 } })
        expect(events[3].retry.maxTries).toBeUndefined()                                               // 不限次数：省略，保证可序列化
        expect(events[3].error.message).toStartWith('模型请求出错（服务端出错，HTTP 503）')                // 和 history 里 role:'error' 同一份正文
        expect(events.filter(event => event.type === 'message' && event.message.role === 'error')).toHaveLength(1) // 相同错误不重复写入、不重复发
        const broken = script([() => { throw error(503, '忙') }])
        const last: any[] = []
        const failure = await Agent.create({ model: broken.model, stream: false, retryMaxTries: 0 }).send('hi', { onEvent: event => { last.push(event) } }).catch(e => e)
        expect(failure.kind).toBe('server')
        expect(last.map(event => event.type)).toEqual(['message', 'request-start', 'message', 'request-error'])
        expect(last[3].retry).toBeUndefined()
    })

    test('requestTimeout 到点贴 kind timeout', async () => {
        const { model } = script([{ text: '永远不会到' }])
        model.doGenerate = (options: any) => new Promise((_, reject) => options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal.reason)))
        const failure = await Agent.create({ model, stream: false, requestTimeout: 100, retryMaxTries: 0 }).send('hi').catch(e => e)
        expect(failure.kind).toBe('timeout')
    })

    test('上下文超长：强制压缩一次再重发', async () => {
        const { model, calls } = script([() => { throw error(400, 'maximum context length exceeded') }, { text: '总结内容' }, { text: '压缩后答复' }])
        const agent = Agent.create({ model, stream: false })
        const types: string[] = []
        const answer = await agent.send('hi', { onEvent: event => { types.push(`${event.type}${'compact' in event && event.compact === true ? '*' : ''}`) } })
        expect(answer.text).toBe('压缩后答复')
        // 超长：这次请求以不带 retry 的 request-error 收尾，压缩自己的请求带 compact，再重发一次新请求
        expect(types).toEqual(['message', 'request-start', 'message', 'request-error', 'compact-start', 'request-start*', 'request-end*', 'message', 'compact-end', 'request-start', 'request-end', 'message', 'step'])
        expect(agent.history.some(message => message.role === 'compact')).toBe(true)
        expect(JSON.stringify(calls.at(-1).prompt)).toContain('总结内容')    // 总结折进了 system
        expect(agent.history.map(one => one.role)).toEqual(['user', 'error', 'compact', 'assistant']) // 超长也记一条错误
    })
})

describe('压缩与估算', () => {
    test('估算超过阈值时自动压缩，总结以 role:compact 追加并折进 system', async () => {
        const { model, calls } = script([{ text: '这是总结' }, { text: '继续干活' }])
        const history: Message[] = [{ id: 'u0', role: 'user', content: '很长的开场'.repeat(1000) }, { id: 'a0', role: 'assistant', content: [{ type: 'text', text: '好' }] }]
        const compacts: string[] = []
        const agent = Agent.create({ model, history, stream: false, maxContextTokens: 1000, context: { head: 0, beforeSummary: 0 } })
        await agent.send('下一步', { onEvent: event => { if (event.type === 'compact-end') compacts.push(event.reason) } })
        expect(compacts).toEqual(['auto'])
        expect(history.at(-2)).toMatchObject({ role: 'compact', content: '这是总结' })
        const prompt = JSON.stringify(calls[1].prompt)
        expect(prompt).toContain('这是总结')
        expect(prompt).not.toContain('很长的开场')                         // beforeSummary 0：总结前的原文一个不留
        expect(prompt).toContain('下一步')                                 // 本次输入落在总结之前，也始终保留
    })

    test('压缩流式推送：compact-start 之后压缩请求的事件都带 compact: true，compact-end 给最终结果', async () => {
        const { model } = script([{ reasoning: '想想', text: '总结' }])
        const agent = Agent.create({ model, history: [{ id: 'u', role: 'user', content: '你好' }] })   // 默认流式
        const events: any[] = []
        expect(await agent.compact({ onEvent: event => { events.push(event) } })).toBe('总结')
        expect(events[0]).toEqual({ type: 'compact-start', reason: 'manual' })
        const end = events.findLastIndex(event => event.type === 'request-end')
        const inner = events.slice(1, end + 1)
        expect(inner.every(event => event.compact === true)).toBe(true)
        expect(inner[0]).toMatchObject({ type: 'request-start', attempt: 1, compact: true })
        expect(inner.filter(event => event.type === 'reasoning').map(event => event.text).join('')).toBe('想想')
        expect(inner.filter(event => event.type === 'text').map(event => event.text).join('')).toBe('总结')
        expect(inner.at(-1).type).toBe('request-end')
        expect(events[end + 1]).toMatchObject({ type: 'message', message: { role: 'compact', content: '总结' } })
        expect(events[end + 1].message.id).toBe(agent.history.at(-1)!.id)
        expect(events.at(-1)).toMatchObject({ type: 'compact-end', reason: 'manual', summary: '总结', usage: { inputTokens: 100 } })
    })

    test('agent.compact() 强制压缩一次，返回总结文字', async () => {
        const { model } = script([{ text: '手动总结' }])
        const agent = Agent.create({ model, stream: false, history: [{ id: 'u', role: 'user', content: '你好' }] })
        expect(await agent.compact()).toBe('手动总结')
        expect(agent.history.at(-1)!.role).toBe('compact')
    })

    test('比例只按模型名记账：真实 usage 校准写进 agent.ratios[模型名]，换服务商也共用', async () => {
        const { model } = script([{ text: '好', inputTokens: 50 }], 'deepseek-v4')
        const agent = Agent.create({ model, stream: false, history: [{ id: 'u', role: 'user', content: '字'.repeat(1000) }] })
        await agent.send('hi')
        const learned = agent.ratios['deepseek-v4']!
        expect(learned).toBeGreaterThan(0)
        expect(learned).toBeLessThan(0.6)
        // 另一台实例（不同服务商 / 协议）沿用同一份表，同名模型直接用学到的值
        const other = script([{ text: '好' }], 'deepseek-v4')
        let seen = 0
        await Agent.create({ model: other.model, protocol: 'anthropic', stream: false, ratios: agent.ratios }).send('hi', { onInject: info => { seen = info.ratio; return undefined } })
        expect(seen).toBe(learned)
    })
})

describe('文字工具', () => {
    test('textTools 打开时：不发原生 tools，说明书进 system，从回复文字里解析调用；不影响同模型的其它实例', async () => {
        const dir = tools({ 'add.ts': tool('add', 'return args.x + 1') })
        const reply = '我来算\n<tool_call>\n{"name": "add", "arguments": {"x": 41}}\n</tool_call>'
        const texty = script([{ text: reply }, { text: '答案 42' }], 'plain-chat')
        const agent = Agent.create({ model: texty.model, tools: [dir], stream: false, textTools: true, noToolRounds: 1 })
        await agent.send('41+1')
        expect(texty.calls[0].tools ?? []).toEqual([])
        expect(JSON.stringify(texty.calls[0].prompt)).toContain('<tool_call>')
        expect(results(agent.history)[0].output.value).toBe(42)
        expect(JSON.stringify(texty.calls[1].prompt)).toContain('tool_result') // 历史里的工具记录改写成文字发给模型
        // 同名模型的另一台实例没开开关：照常发原生 tools，文字原样当回答
        const native = script([{ text: reply }], 'plain-chat')
        const plain = Agent.create({ model: native.model, tools: [dir], stream: false, noToolRounds: 1 })
        await plain.send('41+1')
        expect(toolNames(native.calls[0])).toEqual(['add'])
        expect(results(plain.history)).toEqual([])
    })
})

describe('Agent.LLM.ask', () => {
    test('不建实例也能直接问模型，返回 { text, toolCalls, usage, messages }', async () => {
        const { model } = script([{ text: '直接回答' }])
        const reply = await Agent.LLM.ask({ model, messages: [{ role: 'user', content: 'hi' }], stream: false })
        expect(reply.text).toBe('直接回答')
        expect(reply.toolCalls).toEqual([])
        expect(reply.usage.inputTokens).toBe(100)
    })

    test('Reply.reasoning：流式与非流式都给思考全文，和推送过的片段一致；没有思考是空串；文字工具模式同样带上', async () => {
        const messages = [{ role: 'user' as const, content: 'hi' }]
        const plain = await Agent.LLM.ask({ model: script([{ reasoning: '先想想', text: '答' }]).model, messages, stream: false })
        expect(plain).toMatchObject({ text: '答', reasoning: '先想想' })
        let streamed = ''
        const live = await Agent.LLM.ask({ model: script([{ reasoning: '边想边说', text: '答' }]).model, messages }, chunk => { if (chunk.type === 'reasoning') streamed += chunk.text })
        expect(live.reasoning).toBe('边想边说')
        expect(live.reasoning).toBe(streamed)
        expect((await Agent.LLM.ask({ model: script([{ text: '没想' }]).model, messages })).reasoning).toBe('')
        const tools = { add: { description: '加法', parameters: { type: 'object' as const, properties: { x: { type: 'number' as const } } } } }
        const texty = await Agent.LLM.ask({ model: script([{ reasoning: '要算', text: '<tool_call>{"name":"add","arguments":{"x":1}}</tool_call>' }]).model, messages, tools, textTools: true })
        expect(texty.reasoning).toBe('要算')
        expect(texty.toolCalls).toHaveLength(1)
    })

    test('reasoning 开关：默认摘掉 messages 里的思考块，send 原样发回', async () => {
        const messages: any[] = [{ role: 'user', content: '问' }, { role: 'assistant', content: [{ type: 'reasoning', text: '旧想法' }, { type: 'text', text: '答' }] }, { role: 'user', content: '再问' }]
        const strip = script([{ text: '好' }])
        await Agent.LLM.ask({ model: strip.model, messages, stream: false })
        expect(JSON.stringify(strip.calls[0].prompt)).not.toContain('旧想法')
        const send = script([{ text: '好' }])
        await Agent.LLM.ask({ model: send.model, messages, stream: false, reasoning: 'send' })
        expect(JSON.stringify(send.calls[0].prompt)).toContain('旧想法')
    })
})

describe('回调与诊断', () => {
    test('onEvent 抛错或返回被拒绝的 Promise 都不打断循环；message / tool-run / step 会被等待；返回 steps', async () => {
        const dir = tools({ 'a.ts': tool('a', 'return 1') })
        const { model } = script([{ calls: [{ name: 'a' }] }, { text: '好' }])
        const agent = Agent.create({ model, tools: [dir], noToolRounds: 1 })          // 流式：片段事件是高频回调
        const order: string[] = []
        const answer = await agent.send('hi', {
            onEvent: async event => {
                if (event.type === 'message') { await Bun.sleep(50); order.push(`message:${event.message.role}`) }
                if (event.type === 'tool-result') order.push('result')
                if (event.type === 'tool-run') { await Bun.sleep(50); order.push('run') }
                if (event.type === 'step') { await Bun.sleep(50); order.push(`step${event.step}`) }
                throw new Error('宿主回调坏了')
            },
        })
        expect(answer).toMatchObject({ reason: 'no-tool', text: '好', steps: 2 })
        // message 被等待：assistant 写入后才 tool-run，tool 写入后才 tool-result
        expect(order).toEqual(['message:user', 'message:assistant', 'run', 'message:tool', 'result', 'step1', 'message:assistant', 'step2'])
    })

    test('无效调用（工具不存在）不问权限、不执行，写"调用无效"结果；onPermission 返回非布尔值按拒绝、只警告一次', async () => {
        const dir = tools({ 'a.ts': tool('a', 'return 1') })
        const { model } = script([{ calls: [{ name: 'ghost' }, { name: 'a' }, { name: 'a' }] }, { text: '好' }])
        const agent = Agent.create({ model, tools: [dir], stream: false, noToolRounds: 1 })
        const asked: string[] = []
        const warnings: string[] = []
        await agent.send('hi', { onPermission: call => { asked.push(call.toolName); return 'yes' as any }, onEvent: event => { if (event.type === 'warning') warnings.push(event.message) } })
        expect(asked).toEqual(['a', 'a'])
        const [ghost, first] = results(agent.history)
        expect(ghost.output).toMatchObject({ type: 'error-text', value: expect.stringContaining('工具调用无效') })
        expect(first.output.type).toBe('execution-denied')
        expect(warnings.filter(message => message.includes('onPermission'))).toHaveLength(1)
    })

    test('权限等待中 stop()：立即不等，写"已取消"，send 以 aborted 拒绝', async () => {
        const dir = tools({ 'a.ts': tool('a', 'return 1') })
        const { model } = script([{ calls: [{ name: 'a' }] }])
        const agent: Agent = Agent.create({ model, tools: [dir], stream: false })
        const running = agent.send('hi', { onPermission: () => { setTimeout(() => void agent.stop(), 50); return new Promise<boolean>(() => {}) } })
        expect((await running.catch(e => e)).kind).toBe('aborted')
        expect(results(agent.history)[0].output.value).toBe('工具执行已取消')
    })

    test('send 在等上一次收尾时被 stop()：这一次不开工，它的输入也不写进 history', async () => {
        const { model, calls } = script([{ text: '永远不会到' }])
        model.doGenerate = (options: any) => { calls.push(options); return new Promise((_, reject) => options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal.reason))) }
        const agent = Agent.create({ model, stream: false })
        const first = agent.send('一').catch(e => e)
        await Bun.sleep(20)
        const second = agent.send('二').catch(e => e)
        await agent.stop()
        expect((await first).kind).toBe('aborted')
        expect((await second).kind).toBe('aborted')
        expect(calls).toHaveLength(1)
        expect(JSON.stringify(agent.history)).not.toContain('二')
    })

    test('onInject 拿到阈值和比例来源；compact-end 带 reason、总结正文和诊断；超长重发的 reason 是 overflow', async () => {
        const { model } = script([{ text: '这是总结' }, { text: '继续' }])
        const history: Message[] = [{ id: 'u0', role: 'user', content: '很长的开场'.repeat(1000) }, { id: 'a0', role: 'assistant', content: [{ type: 'text', text: '好' }] }]
        const infos: any[] = []
        const injects: any[] = []
        await Agent.create({ model, history, stream: false, maxContextTokens: 1000 }).send('下一步', { onEvent: event => { if (event.type === 'compact-end') infos.push(event) }, onInject: info => { injects.push(info); return undefined } })
        expect(infos[0]).toMatchObject({ reason: 'auto', summary: '这是总结', budget: 1000, compactThreshold: 0.8, ratioSource: 'default' })
        expect(infos[0].before).toBeGreaterThan(infos[0].after)
        expect(injects[0]).toMatchObject({ budget: 1000, compactThreshold: 0.8, ratioSource: 'default' })

        let first = true
        const overflow = script([() => { if (first) { first = false; throw new APICallError({ message: 'maximum context length exceeded', url: 'http://x', requestBodyValues: {}, statusCode: 400 }) } return { text: '总结' } }, { text: '答' }])
        const reasons: string[] = []
        await Agent.create({ model: overflow.model, stream: false }).send('hi', { onEvent: event => { if (event.type === 'compact-end') reasons.push(event.reason) } })
        expect(reasons).toEqual(['overflow'])
    })

    test('provider.toolChoice 只在真的带工具时发送：压缩请求和没有工具的请求都不带', async () => {
        const dir = tools({ 'a.ts': tool('a', "return { output: 1, stop: true }") })
        const { model, calls } = script([{ text: '总结' }, { calls: [{ name: 'a' }] }])
        const agent = Agent.create({ model, tools: [dir], stream: false, provider: { toolChoice: 'required' }, history: [{ id: 'u', role: 'user', content: '你好' }] })
        expect(await agent.compact()).toBe('总结')                                    // 'required' 漏到压缩请求上会因"没调工具"报错
        expect((await agent.send('hi')).reason).toBe('tool-stop')
        expect(calls[0].toolChoice?.type).not.toBe('required')
        expect(calls[1].toolChoice).toEqual({ type: 'required' })
    })

    test('文字工具流式：调用块之外的正文边收边推，调用块本身不推；不是调用的标签照常推', async () => {
        const dir = tools({ 'add.ts': tool('add', 'return args.x + 1') })
        const { model } = script([{ text: '我来算<tool_call>{"name": "add", "arguments": {"x": 41}}</tool_call>' }, { text: '答案 <b>42</b>' }], 'plain-chat')
        const agent = Agent.create({ model, tools: [dir], textTools: true, noToolRounds: 1 })
        let text = ''
        await agent.send('41+1', { onEvent: event => { if (event.type === 'text') text += event.text } })
        expect(text).toBe('我来算答案 <b>42</b>')
        expect(results(agent.history)[0].output.value).toBe(42)
    })
})

describe('问模型出错写进 history', () => {
    const fail = (statusCode: number, message: string) => () => { throw new APICallError({ message, url: 'http://x.test', requestBodyValues: {}, statusCode, isRetryable: true }) }
    const errors = (history: Message[]) => history.filter(message => message.role === 'error') as any[]

    test('每次重试前记一条，和上一条相同的不重复；成功后照常回答', async () => {
        const { model } = script([fail(503, '服务繁忙'), fail(503, '服务繁忙'), fail(429, '太快了'), { text: '好了' }])
        const agent = Agent.create({ model, stream: false, retryBaseDelay: 1 })
        expect((await agent.send('hi')).text).toBe('好了')
        const list = errors(agent.history)
        expect(list.map(one => one.content)).toEqual(['模型请求出错（服务端出错，HTTP 503）：服务繁忙', '模型请求出错（被限流，HTTP 429）：太快了'])
        expect(list[0].request).toEqual({ kind: 'server', statusCode: 503, model: 'mock-model', protocol: 'chat', attempt: 1 })
        expect(list[1].request.attempt).toBe(3)
        expect(agent.history.map(one => one.role)).toEqual(['user', 'error', 'error', 'assistant'])
    })

    test('最终失败也记；和重试前那条相同就不再追加', async () => {
        const { model } = script([fail(401, 'key 不对')])
        const agent = Agent.create({ model, stream: false, retryBaseDelay: 1, retryMaxTries: 1 })
        await expect(agent.send('hi')).rejects.toMatchObject({ kind: 'auth' })
        expect(errors(agent.history).map(one => one.request.attempt ?? 'final')).toEqual([1])
        const once = Agent.create({ model: script([fail(400, '参数错')]).model, stream: false, retryMaxTries: 0 })
        await expect(once.send('hi')).rejects.toMatchObject({ kind: 'request' })
        expect(errors(once.history).map(one => one.request)).toEqual([{ kind: 'request', statusCode: 400, model: 'mock-model', protocol: 'chat', final: true }])
    })

    test('用户 stop() 不记', async () => {
        const { model } = script([() => Bun.sleep(100).then(fail(503, '停止期间才失败'))])  // 失败落在 stop() 之后：按取消处理
        const agent = Agent.create({ model, stream: false })
        const pending = agent.send('hi').catch(error => error)
        await Bun.sleep(20)
        await agent.stop()
        expect((await pending).kind).toBe('aborted')
        expect(errors(agent.history)).toEqual([])
    })

    test('压缩请求出错按同一规则记，request 带 compact: true；压缩不沿用主配置的 maxTokens', async () => {
        const broken = Agent.create({ model: script([fail(500, '挂了')]).model, stream: false, retryMaxTries: 0, history: [{ id: 'a', role: 'user', content: 'hi' }, { id: 'b', role: 'assistant', content: '你好' }] as any })
        await expect(broken.compact()).rejects.toMatchObject({ kind: 'server' })
        expect(errors(broken.history)[0].request).toMatchObject({ kind: 'server', compact: true, final: true })
        const { model, calls } = script([{ text: '总结' }])
        const agent = Agent.create({ model, stream: false, maxTokens: 50, history: [{ id: 'a', role: 'user', content: 'hi' }] as any })
        await agent.compact()
        expect(calls[0].maxOutputTokens).toBeUndefined()
    })
})

describe('请求记录挂在消息上', () => {
    test('流式：每次请求一条 assistant（纯调工具也是），带 model / start / first / duration / usage；发给模型时不带', async () => {
        const dir = tools({ 'a.ts': tool('a', 'return 1') })
        const { model, calls } = script([{ calls: [{ name: 'a' }] }, { text: '好了' }])
        const agent = Agent.create({ model, tools: [dir], noToolRounds: 1 })
        const before = Date.now()
        await agent.send('hi')
        const replies = agent.history.filter(message => message.role === 'assistant')
        expect(replies.length).toBe(2)                                        // 两次请求 = 两条 assistant
        for (const reply of replies) {
            const request = (reply as any).request
            expect(request).toMatchObject({ model: 'mock-model', usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 } })
            expect(request.start).toBeGreaterThanOrEqual(before)
            expect(request.first).toBeGreaterThanOrEqual(0)
            expect(request.duration).toBeGreaterThanOrEqual(request.first)
            expect(Object.keys(request.usage).sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'output'])
        }
        const sent = JSON.stringify(calls[1].prompt)                          // 第二次请求带着第一条 assistant
        expect(sent).toContain('tool-call')
        expect(sent).not.toContain('"request"')
        expect(sent).not.toContain(String((replies[0] as any).request.start))
    })

    test('非流式没有 first；供应商不报用量时没有 usage（不填 0），合计照样是数字', async () => {
        const { model } = script([{ text: '好', noUsage: true }])
        const agent = Agent.create({ model, stream: false })
        const answer = await agent.send('hi')
        const request = (agent.history.at(-1) as any).request
        expect(request.model).toBe('mock-model')
        expect(request.duration).toBeGreaterThanOrEqual(0)
        expect('first' in request).toBe(false)
        expect('usage' in request).toBe(false)
        expect(answer.usage.inputTokens).toBe(0)
    })

    test('压缩请求的记录挂在 compact 消息上，之后的请求里不带', async () => {
        const { model, calls } = script([{ text: '总结', inputTokens: 30 }, { text: '继续' }], 'mini')
        const agent = Agent.create({ model, history: [{ id: 'u', role: 'user', content: 'hi' }] })
        await agent.compact()
        const summary = agent.history.at(-1) as any
        expect(summary.role).toBe('compact')
        expect(summary.request).toMatchObject({ model: 'mini', usage: { input: 30, output: 5 } })
        expect(typeof summary.request.start).toBe('number')
        await agent.send('接着来')
        expect(JSON.stringify(calls[1].prompt)).not.toContain('"request"')
        expect(JSON.stringify(calls[1].prompt)).toContain('总结')               // 总结照样折进了上下文
    })
})
