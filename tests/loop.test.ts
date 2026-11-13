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
        await agent.send('hi', { onStep: ({ step }) => { if (step === 1) agent.tools = [two] } }) // 关掉插件 one，打开插件 two
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
            onStep: () => {
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

    test('流式：onChunk 收到 text / tool-call / tool-result / finish，返回值与回调一致', async () => {
        const dir = tools({ 'a.ts': tool('a', 'return 1') })
        const { model } = script([{ calls: [{ name: 'a' }] }, { text: '好的' }])
        const chunks: string[] = []
        let text = ''
        const answer = await Agent.create({ model, tools: [dir], noToolRounds: 1 }).send('hi', { onChunk: chunk => { chunks.push(chunk.type); if (chunk.type === 'text') text += chunk.text } })
        expect(chunks).toContain('tool-call')
        expect(chunks).toContain('tool-result')
        expect(chunks).toContain('finish')
        expect(text).toBe(answer.text)
    })
})

describe('模型错误', () => {
    const error = (statusCode: number, message: string) => new APICallError({ message, url: 'http://x', requestBodyValues: {}, statusCode, responseBody: message })

    test('5xx 按配置重试，onRetry 收到通知；maxTries 用尽后抛带 kind 的错误', async () => {
        let fails = 2
        const { model } = script([() => { if (fails-- > 0) throw error(503, '忙'); return { text: '好' } }])
        const retries: number[] = []
        const answer = await Agent.create({ model, stream: false, retryBaseDelay: 0 }).send('hi', { onRetry: info => retries.push(info.attempt) })
        expect(answer.text).toBe('好')
        expect(retries).toEqual([1, 2])
        const broken = script([() => { throw error(503, '忙') }])
        const failure = await Agent.create({ model: broken.model, stream: false, retryMaxTries: 0 }).send('hi').catch(e => e)
        expect(failure.kind).toBe('server')
    })

    test('requestTimeout 到点贴 kind timeout', async () => {
        const { model } = script([{ text: '永远不会到' }])
        model.doGenerate = (options: any) => new Promise((_, reject) => options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal.reason)))
        const failure = await Agent.create({ model, stream: false, requestTimeout: 100, retryMaxTries: 0 }).send('hi').catch(e => e)
        expect(failure.kind).toBe('timeout')
    })

    test('上下文超长：强制压缩一次再重发', async () => {
        let first = true
        const { model, calls } = script([
            () => { if (first) { first = false; throw error(400, 'maximum context length exceeded') } return { text: '总结内容' } },
            { text: '压缩后答复' },
        ])
        const agent = Agent.create({ model, stream: false })
        const answer = await agent.send('hi')
        expect(answer.text).toBe('压缩后答复')
        expect(agent.history.some(message => message.role === 'compact')).toBe(true)
        expect(JSON.stringify(calls.at(-1).prompt)).toContain('总结内容')    // 总结折进了 system
    })
})

describe('压缩与估算', () => {
    test('估算超过阈值时自动压缩，总结以 role:compact 追加并折进 system', async () => {
        const { model, calls } = script([{ text: '这是总结' }, { text: '继续干活' }])
        const history: Message[] = [{ id: 'u0', role: 'user', content: '很长的开场'.repeat(1000) }, { id: 'a0', role: 'assistant', content: [{ type: 'text', text: '好' }] }]
        const compacts: string[] = []
        const agent = Agent.create({ model, history, stream: false, maxContextTokens: 1000, context: { head: 0, beforeSummary: 0 } })
        await agent.send('下一步', { onCompact: info => compacts.push(info.reason) })
        expect(compacts).toEqual(['auto'])
        expect(history.at(-2)).toMatchObject({ role: 'compact', content: '这是总结' })
        const prompt = JSON.stringify(calls[1].prompt)
        expect(prompt).toContain('这是总结')
        expect(prompt).not.toContain('很长的开场')                         // beforeSummary 0：总结前的原文一个不留
        expect(prompt).toContain('下一步')                                 // 本次输入落在总结之前，也始终保留
    })

    test('压缩流式推送：compact-start 之后压缩模型的思考 / 正文 / finish 都带 compact: true，onCompact 照常给最终结果', async () => {
        const { model } = script([{ reasoning: '想想', text: '总结' }])
        const agent = Agent.create({ model, history: [{ id: 'u', role: 'user', content: '你好' }] })   // 默认流式
        const chunks: any[] = []
        const finals: any[] = []
        expect(await agent.compact({ onChunk: chunk => chunks.push(chunk), onCompact: info => finals.push(info) })).toBe('总结')
        expect(chunks[0]).toEqual({ type: 'compact-start', reason: 'manual', compact: true })
        expect(chunks.every(chunk => chunk.compact === true)).toBe(true)
        expect(chunks.filter(chunk => chunk.type === 'reasoning').map(chunk => chunk.text).join('')).toBe('想想')
        expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.text).join('')).toBe('总结')
        expect(chunks.at(-1).type).toBe('finish')
        expect(finals).toHaveLength(1)
        expect(finals[0]).toMatchObject({ reason: 'manual', usage: { inputTokens: 100 } })
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
