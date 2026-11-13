/*
能力模块的单元测试：上下文保留规则（head / beforeSummary / budget）、history 规则、文字工具解析、
输出成形、token 估算与校准、decide。这些都是纯函数（或只改传进去的对象），不起进程、不问模型。
*/

import { describe, expect, test } from 'bun:test'
import type { Message, State } from '../../src/types.ts'
import { build } from '../../src/context/build.ts'
import { append, turns, unanswered } from '../../src/history.ts'
import { parse } from '../../src/model/text-tools/parse.ts'
import { describe as describeTools } from '../../src/model/text-tools/describe.ts'
import { shape } from '../../src/tools/shape.ts'
import { calibrate, current, estimate } from '../../src/utils/tokens.ts'
import { decide } from '../../src/loop/decide.ts'
import { classify } from '../../src/utils/errors.ts'

// 造一个 State：只填 build 用得到的字段。
const stateOf = (history: Message[], config: Record<string, unknown> = {}): State => ({
    id: 't', config: { model: 'm', ...config } as any, history, tools: [], mcp: [], contextRatio: undefined, ratios: {},
    internal: { procs: new Set(), toolCache: new Map(), mcpClients: new Map(), controller: null, running: null, warned: new Set() },
})
// 造一段历史：n 个用户回合（每个回合一问一答），然后一条总结，再一个新回合。
const withSummary = (n: number, size = 10) => {
    const history: Message[] = []
    for (let i = 1; i <= n; i += 1) {
        history.push({ id: `u${i}`, role: 'user', content: `问${i}` + '字'.repeat(size) })
        history.push({ id: `a${i}`, role: 'assistant', content: [{ type: 'text', text: `答${i}` }] })
    }
    history.push({ id: 'c', role: 'compact', content: '总结正文' })
    history.push({ id: 'u-new', role: 'user', content: '新问题' })
    return history
}
const texts = (messages: any[]) => messages.map(message => typeof message.content === 'string' ? message.content.slice(0, 3) : message.content[0].text.slice(0, 3))

describe('context/build', () => {
    test('默认：开场不留、总结前留 10 轮、总结后全部；总结折进 system；id / error 被去掉', () => {
        const history = withSummary(12)
        history.push({ id: 'e', role: 'error', content: '宿主记录' })
        const built = build(stateOf(history), {})
        expect(built.system).toContain('总结正文')
        expect(texts(built.messages)[0]).toBe('问3字')                       // 12 轮里留最近 10 轮
        expect(texts(built.messages).at(-1)).toBe('新问题')
        expect(built.messages.every((message: any) => !('id' in message))).toBe(true)
        expect(JSON.stringify(built.messages)).not.toContain('宿主记录')
    })

    test('head 留开场 N 轮，beforeSummary 留总结前 M 轮，顺序按时间', () => {
        const built = build(stateOf(withSummary(6), { context: { head: 1, beforeSummary: 2 } }), {})
        expect(texts(built.messages).filter(text => text.startsWith('问'))).toEqual(['问1字', '问5字', '问6字'])
    })

    test('budget 超出时从最早的一轮开始丢（只约束 head + beforeSummary 两段）', () => {
        const history = withSummary(4, 1000)                                // 每轮约 600 token
        const built = build(stateOf(history, { maxContextTokens: 10000, context: { head: 1, beforeSummary: 3, budget: 0.15 } }), {})
        expect(texts(built.messages).filter(text => text.startsWith('问'))).toEqual(['问3字', '问4字']) // 预算 1500：只装得下最近两轮
    })

    test('媒体默认不发：mediaFallback error 报错，strip 只留文字', () => {
        const history: Message[] = [{ id: 'u', role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', image: 'aGk=' }] }]
        expect(() => build(stateOf(history), {})).toThrow('image')
        expect(build(stateOf(history, { mediaFallback: 'strip' }), {}).messages[0]!.content).toHaveLength(1)
        expect(build(stateOf(history, { media: { image: true } }), {}).messages[0]!.content).toHaveLength(2)
    })

    test('超过 maxContextTokens × compactThreshold 时 over 为 true', () => {
        expect(build(stateOf(withSummary(1, 2000), { maxContextTokens: 1000 }), {}).over).toBe(false) // 压缩后的上下文很小
        expect(build(stateOf([{ id: 'u', role: 'user', content: '字'.repeat(2000) }], { maxContextTokens: 1000 }), {}).over).toBe(true)
    })
})

describe('history', () => {
    test('append 补 id、原地追加、拒收坏消息', () => {
        const history: Message[] = []
        const message = append(history, { role: 'user', content: 'hi' })
        expect(history[0]).toBe(message)
        expect(message.id).toBeString()
        expect(() => append(history, { role: 'user', content: '  ' })).toThrow()
        expect(() => append(history, { role: 'system', content: 'x' } as any)).toThrow()
        expect(() => append(history, { role: 'compact', content: [] } as any)).toThrow()
    })

    test('turns 按用户回合切分；unanswered 找出没有结果的调用', () => {
        const history: Message[] = [
            { id: '0', role: 'assistant', content: [{ type: 'text', text: '开场白' }] },
            { id: '1', role: 'user', content: 'a' },
            { id: '2', role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'x', toolName: 't', input: {} }, { type: 'tool-call', toolCallId: 'y', toolName: 't', input: {} }] },
            { id: '3', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x', toolName: 't', output: { type: 'text', value: 'ok' } }] },
        ]
        expect(turns(history).map(turn => turn.length)).toEqual([1, 3])
        expect(unanswered(history).map(call => call.toolCallId)).toEqual(['y'])
    })
})

describe('文字工具', () => {
    const spec = describeTools({ add: { description: '加法', parameters: { type: 'object', properties: { a: { type: 'number' } } } } })!

    test('认 <tool_call> JSON 块（含坏 JSON 修复）、工具名标签、已注册工具的 JSON 代码块；丢弃编造的 tool_result', () => {
        expect(parse('<tool_call>{"name":"add","arguments":{"a":1,}}</tool_call>', spec).calls[0]).toMatchObject({ toolName: 'add', input: { a: 1 } })
        expect(parse('<add><a>7</a></add>', spec).calls[0]!.input).toEqual({ a: 7 })
        expect(parse('```json\n{"name":"add","arguments":{"a":2}}\n```', spec).calls).toHaveLength(1)
        expect(parse('```json\n{"name":"other","arguments":{}}\n```', spec).calls).toHaveLength(0)
        const faked = parse('先算 <tool_call>{"name":"add","arguments":{"a":1}}</tool_call><tool_result>2</tool_result>', spec)
        expect(faked.text).toBe('先算')
        expect(faked.calls).toHaveLength(1)
    })
})

describe('tools/shape', () => {
    test('字符串 / 对象 / 空值 / 成形块 / stop 包装 / 截断', async () => {
        expect((await shape('hi')).output).toEqual({ type: 'text', value: 'hi' })
        expect((await shape({ a: 1 })).output).toEqual({ type: 'json', value: { a: 1 } })
        expect((await shape(undefined)).output.type).toBe('text')
        expect((await shape({ type: 'error-text', value: '坏' })).output).toEqual({ type: 'error-text', value: '坏' })
        expect(await shape({ output: '完成', stop: true })).toMatchObject({ output: { type: 'text', value: '完成' }, stop: true })
        const long = await shape('x'.repeat(50), { limit: 10 })
        expect(long.truncated).toBe(true)
        expect(String(long.output.value).startsWith('xxxxxxxxxx\n')).toBe(true)
        const cyclic: any = {}; cyclic.self = cyclic
        expect((await shape(cyclic)).output.type).toBe('error-text')
    })
})

describe('utils', () => {
    test('估算：媒体按块计；比例键只用模型名，学到的优先于冷启动值', () => {
        expect(estimate({ type: 'image', image: 'x'.repeat(100000) }, 0.6).tokens).toBeLessThan(1300)
        const ratios: Record<string, number> = {}
        expect(current(ratios, 'gpt', 0.4)).toBe(0.4)
        calibrate(ratios, 'gpt', 'x'.repeat(1000), 300)
        expect(Object.keys(ratios)).toEqual(['gpt'])
        expect(current(ratios, 'gpt', 0.4)).toBe(ratios.gpt!)
    })

    test('classify 按证据分类', () => {
        expect(classify({ statusCode: 429 })).toBe('limit')
        expect(classify({ statusCode: 400, message: 'maximum context length is 8192' })).toBe('overflow')
        expect(classify(new DOMException('x', 'AbortError'))).toBe('aborted')
        expect(classify(new TypeError('fetch failed'))).toBe('network')
    })

    test('decide：tool-stop 优先；无工具即 finished；第 N-1 轮提醒、第 N 轮 no-tool', () => {
        const reply = { text: '', toolCalls: [], usage: {} as any, messages: [] }
        const result = { toolCallId: 'x', toolName: 't', input: {}, output: {}, stop: true }
        expect(decide({ reply, results: [result], idle: 0, hasTools: true }, { model: 'm' })).toEqual({ action: 'end', reason: 'tool-stop' })
        expect(decide({ reply, results: [], idle: 1, hasTools: false }, { model: 'm' })).toEqual({ action: 'end', reason: 'finished' })
        expect(decide({ reply, results: [], idle: 2, hasTools: true }, { model: 'm', noToolPrompt: '提醒' })).toEqual({ action: 'remind', reminder: '提醒' })
        expect(decide({ reply, results: [], idle: 3, hasTools: true }, { model: 'm' })).toEqual({ action: 'end', reason: 'no-tool' })
    })
})
