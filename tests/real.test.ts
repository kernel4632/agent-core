/*
真实数据测试：四个模型轮流跑同一组场景，请求全部经过 scripts/relay.ts。

- 默认回放：读 tests/fixtures/real 里录好的真实往返，不连网、不花钱，和普通单测一样快；
- RECORD=1（并提供 LINGLOFT_API_KEY / LINGLOFT_BASE_URL）：转发到真实中转站重新录制；REAL_MODELS=逗号分隔的模型名 只录其中几个；
- 录制时每个场景的请求尽量少、输出上限尽量小（用户对额度敏感），不做循环压测。
每个模型一个固定端口（prompt_cache_key 含 baseURL，端口固定请求体才逐字一致）；CROSS 是换协议也能通的组合，各录一次流式文字。
*/

import { describe, expect, test, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Output, jsonSchema } from 'ai'
import { Agent } from '../index.ts'
import type { AskRequest, Chunk, Config } from '../src/types.ts'
import { start, type Relay } from '../scripts/relay.ts'
import { tools } from './helpers.ts'

const RECORD = process.env.RECORD === '1'
const KEY = RECORD ? process.env.LINGLOFT_API_KEY! : 'replay-key'
const ONLY = process.env.REAL_MODELS?.split(',')
const WAIT = RECORD ? 900_000 : 20_000                                    // gemini 经这个中转站首字常要两分钟

const NAMES = ['claude-opus-latest', 'gemini-flash-latest', 'glm-flash-latest', 'gpt-sol-latest']
// cache：这个中转站上实测的缓存表现（read 第二次读到缓存 / write 只看到写入，读不到——请求被路由到不同账号 / none 不报缓存）；
// noSchema：中转站不转发结构化输出的 schema（gemini 实录）；toolTokens：文字工具场景的输出上限（gemini 思考常吃掉 300+，400 会把调用截断）。
// thinking：思考怎么回来（text 有文字 / signature 只有签名没有文字，claude-opus 实录 / none 只计 reasoning_tokens，不回摘要，gpt-sol 实录）。
type Target = { model: string; protocol: 'chat' | 'responses' | 'anthropic' | 'gemini'; base: string; port: number; think?: Record<string, unknown>; cache?: 'read' | 'write' | 'none'; noSchema?: boolean; toolTokens?: number; thinking?: 'text' | 'signature' | 'none' }
const MODELS: Target[] = [
    { model: 'claude-opus-latest', protocol: 'anthropic', base: '/v1', port: 47301, think: { anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } } }, cache: 'write', thinking: 'signature' },
    { model: 'gemini-flash-latest', protocol: 'gemini', base: '/v1beta', port: 47302, think: { google: { thinkingConfig: { includeThoughts: true } } }, noSchema: true, toolTokens: 2000 },
    { model: 'glm-flash-latest', protocol: 'chat', base: '/v1', port: 47303, cache: 'none' },
    { model: 'gpt-sol-latest', protocol: 'responses', base: '/v1', port: 47304, think: { openai: { forceReasoning: true, reasoningEffort: 'low', reasoningSummary: 'auto' } }, cache: 'read', thinking: 'none' },
].filter(one => !ONLY || ONLY.includes(one.model)) as Target[]
const CROSS: Target[] = ([
    ['claude-opus-latest', 'chat', '/v1'], ['gemini-flash-latest', 'chat', '/v1'], ['glm-flash-latest', 'anthropic', '/v1'], ['glm-flash-latest', 'gemini', '/v1beta'],
    ['gpt-sol-latest', 'chat', '/v1'], ['gpt-sol-latest', 'anthropic', '/v1'], ['gpt-sol-latest', 'gemini', '/v1beta'],
] as const).map(([model, protocol, base]) => ({ model, protocol, base, port: 47310 + NAMES.indexOf(model) })).filter(one => !ONLY || ONLY.includes(one.model))

const relays = new Map<number, Relay>()                                   // 一个端口一个中转，按需启动，结束后关掉
const relayOf = (port: number) => relays.get(port) ?? relays.set(port, start({ mode: RECORD ? 'record' : 'replay', port })).get(port)!
afterAll(() => { for (const relay of relays.values()) relay.stop() })

// 场景公共参数：Agent.LLM.ask 用 request()，Agent.create 用 config()；重试最多 1 次、单次 5 分钟（录制时防止无限重试烧额度）。
const base = (m: Target, scenario: string) => ({ model: m.model, protocol: m.protocol, baseURL: relayOf(m.port).url(m.protocol, m.model, scenario, m.base), apiKey: KEY, maxTokens: 400 })
const request = (m: Target, scenario: string, extra: Partial<AskRequest> = {}): AskRequest => ({ ...base(m, scenario), messages: [], retry: { maxTries: 1, timeout: 300_000, baseDelay: 10 }, ...extra })
const config = (m: Target, scenario: string, extra: Partial<Config> = {}): Config => ({ ...base(m, scenario), retryMaxTries: 1, requestTimeout: 300_000, retryBaseDelay: 10, noToolRounds: 1, ...extra })
const user = (content: string) => [{ role: 'user' as const, content }]
// 收集流式片段，返回按类型拼好的全文，用来和返回值逐字核对。
const collect = (chunks: Chunk[] = []) => ({ chunks, onChunk: (chunk: Chunk) => void chunks.push(chunk), joined: (type: 'text' | 'reasoning') => chunks.map(one => one.type === type && !one.compact ? one.text : '').join('') })
const usageOK = (usage: { inputTokens: number; outputTokens: number }) => expect([usage.inputTokens > 0, usage.outputTokens > 0]).toEqual([true, true])
const kindOf = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: any) => error?.kind ?? String(error))
// 写进 history 的形状：每个块的类型 + providerOptions 里的键（签名、itemId 等回传要用的信息），用来比流式和非流式。
const shapeOf = (messages: any[]) => messages.flatMap(one => (one.content as any[]).map(part => [part.type, ...Object.entries(part.providerOptions ?? {}).map(([name, value]) => `${name}:${Object.keys(value as object).sort()}`)].join(' ')))
const shapes = new Map<string, string[]>()                                 // 模型:stream / 模型:generate → 形状
const parts = (history: any[], type: string) => history.flatMap(one => Array.isArray(one.content) ? one.content.filter((part: any) => part.type === type) : [])

// 工具：add 做加法，weather 返回一句固定天气（工具文件和线上一样跑在子进程里）。
const dir = tools({
    'add.ts': `export default { name: 'add', description: '两个数相加，返回和', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }, async run({ a, b }) { return a + b } }\n`,
    'weather.ts': `export default { name: 'weather', description: '查询一个城市今天的天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, async run({ city }) { return city + '：晴，20 度' } }\n`,
})
const LONG = Array.from({ length: 120 }, (_, index) => `第 ${index + 1} 条守则：回答要准确、简短，遇到不确定的事实先说明不确定，不编造数据，引用时注明来源，代码示例必须能运行。`).join('\n')

for (const m of MODELS) describe(`${m.model}（${m.protocol}）`, () => {
    test('text-stream：流式文字，片段与返回值逐字一致', async () => {
        const { chunks, onChunk, joined } = collect()
        const reply = await Agent.LLM.ask(request(m, 'text-stream', { messages: user('只回复两个字：你好') }), onChunk)
        expect(reply.text.length).toBeGreaterThan(0)
        expect(joined('text')).toBe(reply.text)
        expect(chunks.at(-1)?.type).toBe('finish')
        usageOK(reply.usage)
        expect(reply.messages.map(one => one.role)).toEqual(['assistant'])
    }, WAIT)

    test('text-generate：非流式文字，返回形状和流式相同', async () => {
        const reply = await Agent.LLM.ask(request(m, 'text-generate', { stream: false, messages: user('只回复两个字：你好') }))
        expect(reply.text.length).toBeGreaterThan(0)
        usageOK(reply.usage)
        expect(Object.keys(reply).sort()).toEqual(['messages', 'reasoning', 'text', 'toolCalls', 'usage'])
        shapes.set(`${m.model}:generate`, shapeOf(reply.messages))
    }, WAIT)

    test('multi-turn：同一个 Agent 连续两次 send，上一轮回复（含签名 / itemId）原样带回', async () => {
        const agent = Agent.create(config(m, 'multi-turn'))
        await agent.send('记住数字 42，只回复“好”')
        expect((await agent.send('我刚才让你记住的数字是多少？只给数字')).text).toContain('42')
    }, WAIT)

    test('reasoning：思考块流式推送，拼起来等于返回的 reasoning', async () => {
        const { onChunk, joined } = collect()
        const reply = await Agent.LLM.ask(request(m, 'reasoning', { maxTokens: 2000, provider: m.think ? { providerOptions: m.think } : {}, messages: user('一个正整数除以 3 余 2、除以 5 余 3、除以 7 余 2，最小是几？只给数字') }), onChunk)
        shapes.set(`${m.model}:stream`, shapeOf(reply.messages))
        expect(reply.text).toContain('23')
        if ((m.thinking ?? 'text') === 'text') expect(reply.reasoning.length).toBeGreaterThan(0)
        expect(joined('reasoning')).toBe(reply.reasoning)
        if (m.thinking !== 'none') expect(parts(reply.messages, 'reasoning').length).toBeGreaterThan(0) // 思考块（含签名）进 history，发不发回由 reasoning 配置决定
    }, WAIT)

    test('tools-parallel：一次回复里并行调两个工具', async () => {
        const agent = Agent.create({ ...config(m, 'tools-parallel'), tools: [dir] })
        const answer = await agent.send('同时查询北京和上海今天的天气：在同一次回复里并行调用 weather 两次，拿到结果后用一句话汇报。')
        const first = agent.history.find(one => one.role === 'assistant') as any
        expect(parts([first], 'tool-call').length).toBe(2)
        expect(parts(agent.history, 'tool-result').length).toBe(2)
        expect(answer.text).toContain('晴')
    }, WAIT)

    test('tools-multi：多步原生工具调用，后一步用前一步的结果', async () => {
        const agent = Agent.create({ ...config(m, 'tools-multi'), tools: [dir] })
        const answer = await agent.send('先用 add 计算 1+2，拿到结果后再用 add 把这个结果加 3。必须一步一步调用工具，不要心算，最后只回复最终数字。')
        expect(parts(agent.history, 'tool-result').length).toBeGreaterThanOrEqual(2)
        expect(answer.text).toContain('6')
        expect(answer.steps).toBeGreaterThanOrEqual(3)
        usageOK(answer.usage)
    }, WAIT)

    test('text-tools：文字工具模式，history 里仍是标准 tool-call 块', async () => {
        const { onChunk, joined } = collect()
        const agent = Agent.create({ ...config(m, 'text-tools', { textTools: true, noToolRounds: 2, maxTokens: m.toolTokens ?? 400 }), tools: [dir] })
        const answer = await agent.send('先用 add 计算 1+2，拿到结果后再用 add 把这个结果加 3。必须一步一步调用工具，不要心算，最后只回复最终数字。', { onChunk })
        const values = parts(agent.history, 'tool-result').map((part: any) => part.output.value)
        expect([values[0], values.includes(6)]).toEqual([3, true])                       // 真的一步步算了（模型偶尔重复调用；最终回答可能被提醒轮覆盖成空）
        expect(joined('text')).not.toContain('<tool_call')                             // 调用文字不推给宿主
    }, WAIT)

    test('output：结构化输出', async () => {
        const output = Output.object({ schema: jsonSchema<{ city: string; country: string }>({ type: 'object', properties: { city: { type: 'string' }, country: { type: 'string' } }, required: ['city', 'country'], additionalProperties: false }) })
        const pending = Agent.LLM.ask(request(m, 'output', { output, messages: user('中国的首都是哪个城市？按格式回答') }))
        if (m.noSchema) return void expect(await kindOf(pending)).toBe('unknown')     // 中转站不转 responseSchema：模型回纯文字，解析失败归 unknown
        expect(((await pending).output as any)?.city).toContain('北京')
    }, WAIT)

    test('image：图片输入', async () => {
        const agent = Agent.create(config(m, 'image', { media: { image: true } }))
        const image = new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', 'real', 'red.png')))
        const answer = await agent.send([{ type: 'text', text: '这张图是什么颜色？只回答颜色' }, { type: 'file', data: image, mediaType: 'image/png' }] as any)
        expect(answer.text).toContain('红')
    }, WAIT)

    test('compact：手动压缩，总结追加进 history', async () => {
        const history = [
            { id: 'a', role: 'user', content: '我叫小林，在做一个记账 App，用 Bun 写后端。' },
            { id: 'b', role: 'assistant', content: '好的，小林。记账 App 的后端用 Bun。' },
            { id: 'c', role: 'user', content: '数据库决定用 SQLite，金额一律存成分（整数）。' },
            { id: 'd', role: 'assistant', content: '明白：SQLite，金额存整数分。' },
        ] as any
        const agent = Agent.create({ ...config(m, 'compact'), history })
        const summary = await agent.compact()
        expect(summary).toContain('记账')                                                 // gemini 思考吃掉大半 maxTokens，总结会被截断（见报告）
        expect(agent.history.at(-1)!.role).toBe('compact')
        expect(agent.history).toHaveLength(5)
    }, WAIT)

    test('cache：同一段长 system 连问两次，缓存用量字段对得上', async () => {
        const ask = () => Agent.LLM.ask(request(m, 'cache', { stream: false, maxTokens: 50, system: LONG, messages: user('第 7 条守则说了什么？一句话') }))
        const first = await ask()
        const second = await ask()
        for (const usage of [first.usage, second.usage]) for (const value of Object.values(usage)) expect(typeof value).toBe('number')
        if (m.cache === 'read') expect(second.usage.cacheReadTokens).toBeGreaterThan(0)
        if (m.cache === 'write') expect(second.usage.cacheWriteTokens).toBeGreaterThan(0)
    }, WAIT)

    test('error-auth：错的 key 分类为 auth，不重试', async () => {
        expect(await kindOf(Agent.LLM.ask(request(m, 'error-auth', { apiKey: 'sk-wrong-key-for-agent-core-test', retry: { maxTries: 0 }, messages: user('hi') })))).toBe('auth')
    }, WAIT)

    // 这个中转站对不存在的模型回 503 model_not_found，按状态码只能归为 server（默认会无限重试，见报告“待决定”）。
    test('error-model：不存在的模型名（中转站回 503）', async () => {
        expect(await kindOf(Agent.LLM.ask(request(m, 'error-model', { model: 'agent-core-no-such-model', retry: { maxTries: 0 }, messages: user('hi') })))).toBe('server')
    }, WAIT)

    test('abort：收到第一个片段就取消，抛 aborted', async () => {
        const controller = new AbortController()
        const pending = Agent.LLM.ask(request(m, 'abort', { signal: controller.signal, messages: user('从 1 数到 40，用逗号分隔') }), () => controller.abort())
        expect(await kindOf(pending)).toBe('aborted')
    }, WAIT)
})

for (const m of CROSS) describe(`交叉：${m.model} 走 ${m.protocol}`, () => {
    test('text-stream', async () => {
        const { onChunk, joined } = collect()
        const reply = await Agent.LLM.ask(request(m, 'text-stream', { maxTokens: 1000, messages: user('只回复两个字：你好') }), onChunk)
        expect(reply.text.length).toBeGreaterThan(0)
        expect(joined('text')).toBe(reply.text)
        for (const value of Object.values(reply.usage)) expect(typeof value).toBe('number')  // glm 走 anthropic 时中转站把用量全报成 0
    }, WAIT)
})

// 两次回复都带思考块时（claude 的流式 reasoning 与非流式 text-generate）形状必须一致：流式不能多出 custom 元数据块，签名不能丢。
test('history 形状：流式与非流式一致，没有 custom 块', () => {
    for (const shape of shapes.values()) expect(shape.some(one => one.startsWith('custom'))).toBe(false)
    const both = MODELS.filter(m => [':stream', ':generate'].every(end => shapes.get(m.model + end)?.some(one => one.startsWith('reasoning'))))
    if (MODELS.some(m => m.protocol === 'anthropic')) expect(both.map(m => m.protocol)).toContain('anthropic')
    for (const m of both) expect(shapes.get(`${m.model}:stream`)).toEqual(shapes.get(`${m.model}:generate`)!)
})

test.skipIf(RECORD)('回放：发出去的请求体和录制时逐字一致', () => {
    for (const relay of relays.values()) expect(relay.drift).toEqual([])
})
