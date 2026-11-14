/*
loop：唯一的编排者，也是整个项目里唯一写 history 的地方。自己不持有任何状态，状态都从参数 state 拿。

调用示例（只在 agent.ts 里）：
    const answer = await run(state, callbacks)              // send：跑到结束，返回 { reason, text, steps, usage, output }
    const { summary } = await compact(state, callbacks, 'manual') // agent.compact()：强制压缩一次

run 的一轮（循环直到 decide 说结束，不设最大轮数）：
1. 现读工具：tools/load（agent.tools 的元数据）+ tools/mcp connect（agent.mcp，后台连接，只用已连上的），合成这一轮的工具描述表；
2. context/build 现拼上下文；over 为 true 就调 compact('auto') 后重新 build——"何时压"只在这里判断一处；
3. onInject 问宿主要不要临时附一句话；连同上一轮 decide 给的提醒，只挂在这一次请求上，不写进 history；
4. model/ask 问模型（流式片段转给 onChunk）；拿到真实 usage 后用 utils/tokens.calibrate 校准 state.ratios；
   模型报 kind 'overflow'（上下文超长）时强制 compact('overflow') 一次再重发，最多 3 次；
5. 把回复（assistant 消息）追加进 history；
6. 对每个工具调用发 onToolCall（等宿主回调跑完）；无效调用（参数解析失败 / 工具不存在）不问权限、不执行，直接写"调用无效"结果，
   让模型看到原因自己改；其余逐个问 onPermission（没有回调 = 无人值守，直接放行；严格 true 才放行，返回非布尔值警告一次），
   被拒绝的直接写拒绝结果；放行的交给 tools/run 全部并行执行；
7. 结果按调用顺序追加进 history（tool 消息），并发 onToolResult / onChunk('tool-result')，再等 onStep 跑完；
8. loop/decide 判断：继续、带提醒继续、或结束。

每个出口（正常结束、stop()、出错）都会用 history.unanswered 给悬空的调用补一条"已取消"结果，保证 history 不坏。
stop() 时 state.internal.controller 被 abort：ask 抛 kind 'aborted'，run 补完结果后以 cancelled() 拒绝。

导入：同目录 decide；context/build、context/summarize；model/ask；tools/load、tools/run、tools/mcp；
history；utils/tokens、utils/errors。全部是向下或同目录，从不导入 agent。
*/

import { asSchema } from 'ai'
import type { JSONSchema7, ModelMessage } from 'ai'
import type { Answer, AskRequest, Callbacks, CompactReason, Reply, State, ToolResult, Usage } from '../types.ts'
import { decide } from './decide.ts'
import { build } from '../context/build.ts'
import * as summarize from '../context/summarize.ts'
import { ask } from '../model/ask.ts'
import { load } from '../tools/load.ts'
import { connect } from '../tools/mcp.ts'
import { run as runTools } from '../tools/run.ts'
import { append, unanswered } from '../history.ts'
import { calibrate } from '../utils/tokens.ts'
import { cancelled, classify, tell } from '../utils/errors.ts'
import { options as retryOptions } from '../utils/retry.ts'

// 上下文超长时最多"压缩后重发"几次（照抄 Roo Code 的 MAX_CONTEXT_WINDOW_RETRIES）。
export const OVERFLOW_RETRIES = 3

// 把一次请求的用量加进合计（run 和 compact 都要累加，所以抽出来）。
function add(total: Usage, usage: Usage): void {
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    total.totalTokens += usage.totalTokens
    total.cacheReadTokens += usage.cacheReadTokens
    total.cacheWriteTokens += usage.cacheWriteTokens
}

/*
run：按文件头的八步跑完一次 send，返回最终结果。

- 每一轮都从 state 现读 config / history / tools / mcp，宿主运行中改它们，下一轮立即生效；
- 宿主回调一律经 utils/errors.tell 调用：回调抛错或返回被拒绝的 Promise 都不影响循环；onToolCall / onStep 会等它跑完；
- 返回的 text 是最后一次模型回复的正文，steps 是这次 run 问了模型几轮，usage 是全部请求（含压缩请求）的合计，
  output 是结构化输出（config.output 有值时）；和回调里实时给出的内容一致；
- 连续不调工具的计数 idle、提醒文字、用量合计都是这次调用的局部变量，不进 state。
*/
export async function run(state: State, callbacks: Callbacks = {}): Promise<Answer> {
    const { internal } = state
    const signal = internal.controller?.signal ?? new AbortController().signal // 这次运行的取消信号：开始时取一次，stop() 会 abort 它。
    const usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    let idle = 0                                                        // 连续几轮没调工具
    let step = 0                                                        // 第几轮模型请求（重试算同一轮，压缩不算）
    let reminder = ''                                                   // decide 给的临时提醒，只挂在下一次请求上
    try {
        while (true) {
            if (signal.aborted) throw cancelled()
            const config = state.config                                 // 这一轮的配置快照：宿主运行中整份替换也只影响下一轮。

            // --- 1. 现读工具：路径元数据（mtime 缓存）+ MCP；合成发给模型的描述表 ---
            const [metas, mcpTools] = await Promise.all([load(state.tools, internal, callbacks.onWarning), connect(state.mcp, internal.mcpClients, callbacks.onWarning, signal)])
            const schemas: Record<string, { description: string; parameters: JSONSchema7 }> = {}
            for (const meta of metas) schemas[meta.name] = { description: meta.description, parameters: meta.parameters }
            for (const [name, tool] of Object.entries(mcpTools)) schemas[name] = { description: typeof tool.description === 'string' ? tool.description : '', parameters: await asSchema(tool.inputSchema as any).jsonSchema as JSONSchema7 }
            if (signal.aborted) throw cancelled()

            // --- 2. 现拼上下文；超长就压一次再拼（每轮最多压一次：压完仍超长通常是压不动了，循环压只会烧钱）---
            let built = build(state, schemas, callbacks.onWarning)
            if (built.over) { add(usage, (await compact(state, callbacks, 'auto')).usage); built = build(state, schemas, callbacks.onWarning) }

            // --- 3. 宿主要不要临时插一句：放在压缩之后，拿到的才是这一轮真正的估算；钩子坏了就当不注入 ---
            let injected = ''
            if (callbacks.onInject) {
                try { const text = await callbacks.onInject({ tokens: built.tokens, budget: built.budget, compactThreshold: built.threshold, ratio: built.ratio, ratioSource: built.ratioSource }); injected = typeof text === 'string' ? text.trim() : '' } catch { injected = '' }
            }
            const prompt = [reminder, injected].filter(Boolean).join('\n\n')
            reminder = ''

            // --- 4. 问模型；模型说"窗口放不下"时强制压缩再重发，最多 OVERFLOW_RETRIES 次 ---
            let reply: Reply
            for (let attempt = 0; ; attempt += 1) {
                const messages: ModelMessage[] = prompt ? [...built.messages, { role: 'user', content: prompt }] : built.messages // 临时提醒不进 history。
                const request: AskRequest = {
                    model: config.model, baseURL: config.baseURL, apiKey: config.apiKey, protocol: config.protocol,
                    cache: config.cache, provider: config.provider, maxTokens: config.maxTokens, stream: config.stream, includeUsage: config.includeUsage,
                    output: config.output, textTools: config.textTools, reasoning: config.reasoning,
                    system: built.system, messages, tools: Object.keys(schemas).length ? schemas : undefined,
                    retry: retryOptions(config), signal, onRetry: callbacks.onRetry,
                }
                try {
                    reply = await ask(request, callbacks.onChunk)
                    calibrate(state.ratios, config.model, { system: built.system, messages, tools: schemas }, reply.usage.inputTokens) // 和 build 估算用同一份内容，校准才对得上。
                    break
                } catch (error) {
                    if (signal.aborted) throw cancelled()
                    if (attempt >= OVERFLOW_RETRIES || classify(error) !== 'overflow') throw error
                    add(usage, (await compact(state, callbacks, 'overflow')).usage)
                    built = build(state, schemas, callbacks.onWarning)
                }
            }
            step += 1
            add(usage, reply.usage)

            // --- 5. 回复写进 history ---
            for (const message of reply.messages) append(state.history, message)

            // --- 6. 权限：逐个问宿主（并行问），等待期间 stop() 一到就不再等（宿主钩子可能永远不返回）---
            // verdict：true 放行；false 拒绝；'invalid' 调用本身无效（不问权限、不执行）。
            const pathOf = (name: string) => metas.find(meta => meta.name === name)?.path
            const verdicts = await Promise.all(reply.toolCalls.map(async (call): Promise<boolean | 'invalid'> => {
                const info = { ...call, path: pathOf(call.toolName) }
                await tell(callbacks.onToolCall, info)
                if (call.invalid !== undefined) return 'invalid'               // 无效调用问用户也没意义：执行不了。
                if (signal.aborted) return false                               // 已停止：不再问，下面按"已取消"写结果。
                if (!callbacks.onPermission) return true                       // 没有回调 = 无人值守，直接放行。
                let stop = () => {}
                const abort = new Promise<'aborted'>(resolve => { stop = () => resolve('aborted'); signal.addEventListener('abort', stop, { once: true }) })
                try {
                    const verdict = await Promise.race([Promise.resolve(callbacks.onPermission(info)), abort])
                    if (verdict !== 'aborted' && typeof verdict !== 'boolean' && !internal.warned.has('permission')) {
                        internal.warned.add('permission')
                        void tell(callbacks.onWarning, { message: `onPermission 应返回 true / false，实际返回了 ${typeof verdict}；按拒绝处理` })
                    }
                    return verdict === true                                  // 严格 true 才放行。
                } finally { signal.removeEventListener('abort', stop) }       // 每次都摘掉监听：一次运行里问上千次权限也不会堆积。
            }))
            const allowed = reply.toolCalls.filter((_, index) => verdicts[index] === true)
            const ran = await runTools(allowed, { metas, mcpTools }, internal.procs, { signal, limit: config.maxToolOutput, onOutput: callbacks.onToolOutput })

            // --- 7. 结果按调用顺序写回（被拒绝的写拒绝结果，被打断的写"已取消"）---
            const results: ToolResult[] = reply.toolCalls.map((call, index) => verdicts[index] === true
                ? ran[allowed.indexOf(call)]!
                : verdicts[index] === 'invalid' ? { ...call, output: { type: 'error-text', value: `工具调用无效：${call.invalid}` }, error: call.invalid, path: pathOf(call.toolName) }
                : signal.aborted ? { ...call, output: { type: 'error-text', value: '工具执行已取消' }, error: '工具执行已取消', cancelled: true }
                : { ...call, output: { type: 'execution-denied', reason: '工具执行被用户拒绝' }, path: pathOf(call.toolName) })
            for (const result of results) {
                append(state.history, { role: 'tool', content: [{ type: 'tool-result', toolCallId: result.toolCallId, toolName: result.toolName, output: result.output as any }] })
                void tell(callbacks.onToolResult, result)
                void tell(callbacks.onChunk, { type: 'tool-result', result })
            }
            await tell(callbacks.onStep, { step, reply, results })
            if (signal.aborted) throw cancelled()                       // 结果已经写完，history 是完整的，再按取消抛出。

            // --- 8. 判断继续、提醒还是结束 ---
            idle = reply.toolCalls.length ? 0 : idle + 1
            const decision = decide({ reply, results, idle, hasTools: Object.keys(schemas).length > 0 }, config)
            if (decision.action === 'end') return { reason: decision.reason, text: reply.text, steps: step, usage: { ...usage }, ...(reply.output !== undefined ? { output: reply.output } : {}) }
            if (decision.action === 'remind') reminder = decision.reminder
        }
    } finally {
        // 兜底：任何出口都不留悬空的工具调用（例如权限钩子抛错时，回复已写入但结果还没写）。
        for (const call of unanswered(state.history)) {
            append(state.history, { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'error-text', value: '工具执行已取消' } }] })
        }
    }
}

/*
compact：整个项目唯一的压缩逻辑（取代旧实现的三个同名 compact）。只负责压缩，不判断要不要压。

1. build 当前上下文；
2. summarize.request 拼"写总结"的请求（可用 config.compact 里的便宜模型）；
3. ask 问模型，取回总结文字；开始前发一条 onChunk({ type: 'compact-start' })，压缩模型的思考 / 正文 / finish
   片段带上 compact: true 实时转给 onChunk（宿主能看到压缩时模型在想什么、总结正文是什么）；
4. summarize.wrap 包成 role:'compact' 消息，append 进 history；
5. 发 onCompact（reason、总结正文、压缩前后估算及其诊断、用量），返回总结文字和这一笔请求的用量（run 要把它计进合计）。
reason：'manual' 来自宿主的 agent.compact()；'auto' 来自 run 的阈值判断（估算到了 compactThreshold）；
'overflow' 来自模型报上下文超长后的强制压缩（说明估算偏小，宿主排查时要分开看）。
压缩请求不带工具；是否流式跟随配置（config.compact.stream ?? config.stream，默认流式），非流式时只有 compact-start。
*/
export async function compact(state: State, callbacks: Callbacks = {}, reason: CompactReason = 'manual'): Promise<{ summary: string; usage: Usage }> {
    const signal = state.internal.controller?.signal
    const before = build(state, {}, callbacks.onWarning)
    void tell(callbacks.onChunk, { type: 'compact-start', reason, compact: true })
    const reply = await ask({ ...summarize.request(before, state.config), signal, onRetry: callbacks.onRetry }, chunk => tell(callbacks.onChunk, { ...chunk, compact: true }))
    const message = append(state.history, summarize.wrap(reply.text)) as { content: string }
    const { budget, threshold: compactThreshold, ratio, ratioSource, chars, media } = before
    void tell(callbacks.onCompact, { reason, summary: message.content, before: before.tokens, after: build(state, {}).tokens, budget, compactThreshold, ratio, ratioSource, chars, media, usage: reply.usage })
    return { summary: message.content, usage: reply.usage }
}
