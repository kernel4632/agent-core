/*
能力模块的单元测试：上下文保留规则（head / beforeSummary / budget）、history 规则、文字工具解析、
输出成形、token 估算与校准、decide。这些都是纯函数（或只改传进去的对象），不起进程、不问模型。
*/

import { describe, expect, test } from 'bun:test'
import type { Message, State } from '../src/types.ts'
import { build } from '../src/context/build.ts'
import { append, turns, unanswered } from '../src/history.ts'
import { parse } from '../src/model/text-tools/parse.ts'
import { describe as describeTools } from '../src/model/text-tools/describe.ts'
import { shape } from '../src/tools/shape.ts'
import { calibrate, current, estimate } from '../src/utils/tokens.ts'
import { decide } from '../src/loop/decide.ts'
import { classify, tell } from '../src/utils/errors.ts'
import { retry } from '../src/utils/retry.ts'
import { configure } from '../src/model/configure.ts'

// 造一个 State：只填 build 用得到的字段。
const stateOf = (history: Message[], config: Record<string, unknown> = {}): State => ({
    id: 't', config: { model: 'm', ...config } as any, history, tools: [], MCP: [], contextRatio: undefined, ratios: {},
    internal: { procs: new Set(), toolCache: new Map(), MCPClients: new Map(), controller: null, running: null, warned: new Set() },
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

    test('进行中的那一轮整轮放不下：用户那句话必留，再按步从后往前补装得下的最近几步；budget 0 只留那句话', () => {
        const step = (n: number, size: number): Message[] => [
            { id: `a${n}`, role: 'assistant', content: [{ type: 'tool-call', toolCallId: `t${n}`, toolName: 'x', input: {} }] },
            { id: `r${n}`, role: 'tool', content: [{ type: 'tool-result', toolCallId: `t${n}`, toolName: 'x', output: { type: 'text', value: `结果${n}` + '字'.repeat(size) } }] },
        ]
        const history: Message[] = [
            { id: 'u1', role: 'user', content: '旧问题' },
            { id: 'a0', role: 'assistant', content: [{ type: 'text', text: '旧回答' }] },
            { id: 'u2', role: 'user', content: '当前任务' },
            ...step(1, 3000), ...step(2, 3000), ...step(3, 100),
            { id: 'c', role: 'compact', content: '总结正文' },
        ]
        // 预算 4000 × 0.3 = 1200：只装得下最近的第 3 步（1、2 步各约 1800）；调用和结果成对留下。
        const tight = JSON.stringify(build(stateOf(history, { maxContextTokens: 4000 }), {}).messages)
        expect(tight).toContain('当前任务')
        expect(tight).toContain('结果3')
        expect(tight).not.toContain('结果2')
        expect(tight).not.toContain('旧问题')
        // beforeSummary 0 只管"过去的轮次"：进行中那一轮的现场只受 budget 约束。
        expect(JSON.stringify(build(stateOf(history, { context: { beforeSummary: 0 } }), {}).messages)).toContain('结果1')
        const none = build(stateOf(history, { context: { budget: 0 } }), {}).messages
        expect(none).toEqual([{ role: 'user', content: '当前任务' }])
        // 上一次压缩之前的步已经总结过两次，不再回头捡。
        const twice: Message[] = [{ id: 'u', role: 'user', content: '任务' }, ...step(1, 10), { id: 'c0', role: 'compact', content: '第一次' }, ...step(2, 10), { id: 'c1', role: 'compact', content: '第二次' }]
        const again = JSON.stringify(build(stateOf(twice, { maxContextTokens: 4000 }), {}).messages)
        expect(again).toContain('结果2')
        expect(again).not.toContain('结果1')
    })

    test('思考块：默认 strip 摘掉（被摘空的消息整条丢），reasoning: send 原样发回', () => {
        const history: Message[] = [
            { id: 'u', role: 'user', content: '问' },
            { id: 'a', role: 'assistant', content: [{ type: 'reasoning', text: '想法' }, { type: 'text', text: '答' }] },
            { id: 'b', role: 'assistant', content: [{ type: 'reasoning', text: '只有想法' }] },
        ]
        expect(JSON.stringify(build(stateOf(history), {}).messages)).not.toContain('想法')
        expect(build(stateOf(history), {}).messages).toHaveLength(2)
        const sent = build(stateOf(history, { reasoning: 'send' }), {}).messages
        expect(sent).toHaveLength(3)
        expect(JSON.stringify(sent)).toContain('只有想法')
    })

    test('媒体：没开的类型换成占位文字（不报错、不改 history），开了的统一成 v7 file；工具结果里的媒体同样处理', () => {
        const history: Message[] = [
            { id: 'u', role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', image: 'aGk=' }, { type: 'image', image: 'https://x.test/a.png' } as any,
                { type: 'file', mediaType: 'audio/wav', data: { type: 'url', url: 'data:audio/wav;base64,aGk=' } } as any, { type: 'file-data', data: 'aGk=', mediaType: 'application/pdf', filename: 'a.pdf' } as any] },
            { id: 'a', role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't', toolName: 'shot', input: {} }] },
            { id: 'r', role: 'tool', content: [{ type: 'tool-result', toolCallId: 't', toolName: 'shot', output: { type: 'content', value: [{ type: 'text', text: '截图' }, { type: 'image', image: 'aGk=' } as any] } }] },
        ]
        const snapshot = JSON.stringify(history)
        const off = build(stateOf(history), {}).messages as any[]
        expect(off[0].content.map((part: any) => part.type)).toEqual(['text', 'text', 'text', 'text', 'text'])
        expect(off[0].content[1].text).toContain('图片')
        expect(off[0].content[4].text).toContain('a.pdf')
        expect(off[2].content[0].output.value[1].text).toContain('未开启图片输入')
        expect(JSON.stringify(history)).toBe(snapshot)                                 // history 原样不动，换个模型原件照常发出
        const on = build(stateOf(history, { media: { image: true, audio: true, file: true } }), {}).messages as any[]
        const [, bare, link, audio, pdf] = on[0].content
        expect(bare).toEqual({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' } })
        expect(link.data.url).toBeInstanceOf(URL)                                      // 字符串网址包成 URL 对象
        expect(audio.data.url).toBeInstanceOf(URL)                                     // 存成 JSON 后变成字符串的 data URL 也恢复成 URL
        expect(pdf).toEqual({ type: 'file', mediaType: 'application/pdf', filename: 'a.pdf', data: { type: 'data', data: 'aGk=' } })
        expect(on[2].content[0].output.value[1]).toEqual({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' } })
    })

    test('发不出去的消息跳过并只提醒一次；乱序的工具结果按 toolCallId 跟回它的调用后面', () => {
        const history: Message[] = [
            { id: 'u', role: 'user', content: '问' },
            { id: 's', role: 'system', content: '旧系统提示' } as any,
            { id: 'n', role: 'user', content: null } as any,
            { id: 'a', role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'x', toolName: 't', input: {} }, { type: 'tool-call', toolCallId: 'y', toolName: 't', input: {} }] },
            { id: 'b', role: 'assistant', content: [{ type: 'text', text: '中间插了一句' }] },
            { id: 'ry', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'y', toolName: 't', output: { type: 'text', value: 'Y' } }] },
            { id: 'rx', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x', toolName: 't', output: { type: 'text', value: 'X' } }] },
            { id: 'orphan', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'z', toolName: 't', output: { type: 'text', value: 'Z' } }] },
        ]
        const warnings: string[] = []
        const state = stateOf(history)
        const built = build(state, {}, warning => { warnings.push(warning.message) })
        build(state, {}, warning => { warnings.push(warning.message) })                 // 第二轮不再重复提醒
        expect(warnings).toHaveLength(2)
        expect(warnings[0]).toContain('config.system')
        expect(built.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
        expect((built.messages[2]!.content as any[]).map(part => part.toolCallId)).toEqual(['x', 'y'])
        expect(JSON.stringify(built.messages)).not.toContain('"Z"')
    })

    test('超过 maxContextTokens × compactThreshold 时 over 为 true', () => {
        const compacted = withSummary(3)
        compacted[0] = { id: 'u1', role: 'user', content: '字'.repeat(2000) }                          // 大的是总结前的旧回合（本次输入总会保留，所以不能是它）
        expect(build(stateOf(compacted, { maxContextTokens: 1000 }), {}).over).toBe(false)             // 压缩后的上下文很小
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
        const cyclic: any = {}; cyclic.self = cyclic
        expect((await shape(cyclic)).output.type).toBe('error-text')
    })

    test('形状不合法的成形块转成说明错误；截断保留头 70%、尾 30% 并说明省略了多少；默认不截断', async () => {
        expect((await shape({ type: 'content', value: [{ type: 'image' }] })).output).toMatchObject({ type: 'error-text', value: expect.stringContaining('工具输出不合法') })
        expect((await shape({ type: 'text', value: 1 })).output.type).toBe('error-text')
        const text = 'a'.repeat(70) + 'b'.repeat(30) + 'c'.repeat(100)
        expect((await shape(text)).output.value).toBe(text)                                     // 默认不截断
        const long = await shape('H'.repeat(70) + 'm'.repeat(100) + 'T'.repeat(30), { limit: 100 })
        expect(long.truncated).toBe(true)
        expect(String(long.output.value)).toStartWith('H'.repeat(70) + '\n')
        expect(String(long.output.value)).toEndWith('\n' + 'T'.repeat(30))
        expect(String(long.output.value)).toContain('省略 100 个字符')
        const json = await shape({ big: 'x'.repeat(200) }, { limit: 50 })
        expect(json.output.type).toBe('text')                                                   // json 截断后只能是文字
        const content = await shape({ type: 'content', value: [{ type: 'text', text: 'y'.repeat(200) }] }, { limit: 50 })
        expect(String((content.output.value as any[])[0].text)).toContain('省略')
    })
})

describe('utils', () => {
    test('估算：媒体按块计；比例键只用模型名，学到的优先于冷启动值', () => {
        expect(estimate({ type: 'image', image: 'x'.repeat(100000) }, 0.6).tokens).toBeLessThan(1300)
        const ratios: Record<string, number> = {}
        expect(current(ratios, 'gpt')).toEqual({ ratio: 0.6, source: 'default' })
        expect(current(ratios, 'gpt', 0.4)).toEqual({ ratio: 0.4, source: 'host' })
        calibrate(ratios, 'gpt', 'x'.repeat(1000), 300)
        expect(Object.keys(ratios)).toEqual(['gpt'])
        expect(current(ratios, 'gpt', 0.4)).toEqual({ ratio: ratios.gpt!, source: 'usage' })
    })

    test('classify 按证据分类', () => {
        expect(classify({ statusCode: 429 })).toBe('limit')
        expect(classify({ statusCode: 400, message: 'maximum context length is 8192' })).toBe('overflow')
        expect(classify(new DOMException('x', 'AbortError'))).toBe('aborted')
        expect(classify(new TypeError('fetch failed'))).toBe('network')
        expect(classify({ statusCode: 400, message: 'prompt is too long: max_tokens_to_sample exceeded' })).toBe('overflow')
    })

    test('tell 吞掉同步抛错和异步拒绝；retry 认 shouldRetry，onRetry 带 maxTries', async () => {
        await tell(() => { throw new Error('坏') }, 1)
        await tell(async () => { throw new Error('坏') }, 1)
        const seen: unknown[] = []
        let tries = 0
        const failing = () => { tries += 1; return Promise.reject(Object.assign(new Error('500'), { statusCode: 500 })) }
        await expect(retry(failing, { maxTries: 2, baseDelay: 1, onRetry: async info => { seen.push(info.maxTries); throw new Error('宿主回调坏了') } })).rejects.toThrow('500')
        expect(tries).toBe(3)
        expect(seen).toEqual([2, 2])
        tries = 0
        await expect(retry(failing, { baseDelay: 1, filter: { shouldRetry: () => false } })).rejects.toThrow('500')
        expect(tries).toBe(1)
    })

    test('configure：不带工具时去掉 toolChoice；anthropic 缓存标记合并进已有的 providerOptions', () => {
        const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: 'hi', providerOptions: { anthropic: { citations: true } } }] }]
        const request = { model: 'claude', baseURL: 'http://x.test', protocol: 'anthropic' as const, provider: { toolChoice: 'required', temperature: 0 }, messages }
        expect(configure(request, '系统', messages, false).toolChoice).toBeUndefined()
        expect(configure(request, '系统', messages, true).toolChoice).toBe('required')
        const sent = configure(request, '系统', messages, false).messages as any[]
        expect(sent[0].content[0].providerOptions.anthropic).toEqual({ citations: true, cacheControl: { type: 'ephemeral' } })
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
