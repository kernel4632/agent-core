/*
ask：对 AI SDK 的薄封装，"统一请求数据 → 统一结果"，协议只是参数。公开为 Agent.LLM.ask。

调用示例（不需要 Agent 实例）：
    const { text, toolCalls, usage, output } = await Agent.LLM.ask(
        { model: 'gpt-4o', baseURL, apiKey, protocol: 'chat', messages, tools, textTools: false, retry: { maxTries: 3 } },
        chunk => { if (chunk.type === 'text') process.stdout.write(chunk.text) },
    )

一次 ask 做的事：
1. configure(request) 翻译成 AI SDK 参数；reasoning 不是 'send'（默认 'strip'，与旧版一致）时先摘掉 messages 里的思考块；
2. textTools 为 true：describe 把工具说明写进 system、render 把历史工具消息改写成文字，不发原生 tools；
   否则把 tools 描述表转成 AI SDK 的工具定义（只有 schema，没有 execute——执行在 loop 里做）；
3. 用 retry 包住真正的请求：stream 时走 streamText，把 AI SDK 事件简化成 Chunk 交给 onChunk；
   否则走 generateText。两条路径产出完全相同的 Reply；
   textTools 模式下正文照样流式推送，只扣住"可能是调用"的那一段（<tool_call>、注册过的工具名标签、``` 代码块），
   等它闭合后用 parse 判断：是调用就不推，不是就整段补推；模型编造的 <tool_result> 及其后面都不推；
4. textTools 为 true 时用 parse 从文字里解析出调用；AI SDK 标记为不合法的原生调用（参数解析失败、不符合 schema、工具不存在）
   保留成 invalid（原因），和文字工具写坏的调用同一种形状，由 loop 拒绝执行、把原因回给模型；
5. 用量补齐五个字段（缺的补 0）；错误一律经 classify 贴上 kind 再抛。

ask 不读写 history、不估算 token、不执行工具；它对 loop 一无所知，所以宿主也能直接拿来用。
导入：同目录 configure、text-tools/describe、text-tools/parse，以及 utils/retry、utils/errors。
*/

import { generateText, streamText, tool, jsonSchema } from 'ai'
import type { ModelMessage } from 'ai'
import type { AskRequest, Chunk, Reply, ToolCall, Usage } from '../types.ts'
import { configure } from './configure.ts'
import { describe, render } from './text-tools/describe.ts'
import { parse } from './text-tools/parse.ts'
import { retry } from '../utils/retry.ts'
import { classify, tell } from '../utils/errors.ts'

/*
ask：按文件头的五步问一次模型，返回 Reply。

- onChunk 只在 stream 为 true 时被调用；片段至少有 text / tool-call / finish（reasoning 有就给）；
  onChunk 是宿主代码，同步抛错或异步拒绝都被吞掉（utils/errors.tell），不打断请求；
  文字工具模式下 text 片段拼起来和最终 text 只差空白整理（parse 会收拾删掉调用后留下的空行）；
- 返回值里的 text / reasoning 是正文 / 思考全文（没有思考就是空串），流式时宿主可以拿它们核对推送过的片段；
- 返回值里的 messages 是要追加进 history 的 AI SDK 消息（assistant，带 tool-call 块；不带 id），
  textTools 模式下也是标准的 tool-call 块，这样 history 永远只有一种格式；
- request.signal 取消时抛 kind 'aborted' 的错误；单次超时、重试次数、总时长都来自 request.retry。
*/
export async function ask(request: AskRequest, onChunk?: (chunk: Chunk) => unknown): Promise<Reply> {
    const emit = (chunk: Chunk) => void tell(onChunk, chunk)             // 高频回调不等它；出错（含异步拒绝）吞掉。
    const stream = request.stream ?? true                                 // 默认流式：用户能实时看到文字。

    // --- 2. 文字工具：说明书进 system，历史工具记录改写成文字，不发原生 tools ---
    const spec = request.textTools ? describe(request.tools) : null
    const system = spec ? [request.system, spec.instructions].filter(Boolean).join('\n\n') : request.system
    // 思考块回传开关：默认摘掉（多数供应商不收），被摘空的 assistant 消息整条丢掉；'send' 原样发回。
    const outgoing = request.reasoning === 'send' ? request.messages : request.messages.flatMap(message => {
        if (!Array.isArray(message.content)) return [message]
        const content = (message.content as { type: string }[]).filter(part => part.type !== 'reasoning')
        return content.length ? [{ ...message, content } as ModelMessage] : []
    })
    const messages = spec ? render(outgoing) : outgoing
    // 原生工具只给 schema 不给 execute：AI SDK 只会返回调用，执行由 loop 负责（子进程 / MCP）。
    const tools = !spec && request.tools && Object.keys(request.tools).length
        ? Object.fromEntries(Object.entries(request.tools).map(([name, one]) => [name, tool({ description: one.description, inputSchema: jsonSchema(one.parameters as any) })]))
        : undefined

    try {
        const result = await retry(async ({ signal }) => {
            // --- 1. 翻译参数（每次尝试现拼：重试之间什么都不缓存）---
            const call = { ...configure(request, system, messages, Boolean(tools)), ...(tools ? { tools } : {}), abortSignal: signal } as any
            if (!stream) {
                const done = await generateText(call)
                const reasoning = done.reasoningText ?? (done.reasoning ?? []).map((part: any) => part.text ?? '').join('')
                return { text: done.text, reasoning, toolCalls: done.toolCalls, usage: done.usage, messages: done.responseMessages, output: call.output && !done.toolCalls.length ? done.output : undefined }
            }
            const running = streamText(call)
            // 文字工具模式的流式：all 是到目前为止的全部正文，sent 是已经推送或确认跳过的字符数。
            let all = '', sent = 0
            const flush = (done: boolean) => {
                while (spec && sent < all.length) {
                    const rest = all.slice(sent)
                    const hold = rest.search(/[<`]/)                      // 只有 < 和 ` 可能开始一个调用。
                    if (hold !== 0) { const free = hold < 0 ? rest : rest.slice(0, hold); emit({ type: 'text', text: free }); sent += free.length; continue }
                    if (rest.startsWith('<tool_result')) return           // 模型编造的工具结果：从这里往后都不推（parse 也会丢掉）。
                    const fence = rest[0] === '`'
                    const name = fence ? '' : /^<([\w.-]*)/.exec(rest)![1]!
                    const next = rest[name.length + 1]
                    // 还可能是调用吗：``` 代码块；或 < 后面跟着 tool_call / 注册过的工具名（名字还没写完时按前缀判断）。
                    const possible = fence ? (rest.length < 3 ? '```'.startsWith(rest) : rest.startsWith('```'))
                        : next === undefined ? ['tool_call', 'tool_result', ...spec.names].some(one => one.startsWith(name))
                        : next === '>' && (name === 'tool_call' || spec.names.includes(name))
                    if (!possible) { emit({ type: 'text', text: rest[0]! }); sent += 1; continue }
                    const close = fence ? rest.indexOf('```', 3) : rest.indexOf(`</${name}>`)
                    if (close >= 0) {                                     // 块已闭合：是调用就跳过，不是就整段补推。
                        const block = rest.slice(0, close + (fence ? 3 : name.length + 3))
                        if (!parse(block, spec).calls.length) emit({ type: 'text', text: block })
                        sent += block.length
                        continue
                    }
                    if (!done) return                                     // 还没闭合：等后面的片段。
                    if (!parse(rest, spec).calls.length) emit({ type: 'text', text: rest }) // 到结尾也没闭合：不是调用就补推。
                    sent = all.length
                }
            }
            // 流中途出错时，AI SDK 会让所有"最后才结算"的 promise 一起 reject；没被 await 到的会变成未处理拒绝，
            // Bun 会因此直接退出宿主进程（旧实现 issue #26）。先挂上兜底 catch，真正的错误仍在 await 处抛出。
            for (const settled of [running.toolCalls, running.finishReason, running.usage, running.responseMessages, running.output]) (settled as any)?.catch?.(() => {})
            let failure: unknown = null
            const parts: string[] = []                                            // 推送过的正文片段
            const thoughts: string[] = []                                         // 推送过的思考片段
            for await (const event of running.fullStream as AsyncIterable<any>) {
                if (event.type === 'text-delta') { parts.push(event.text); if (spec) { all += event.text; flush(false) } else emit({ type: 'text', text: event.text }) }
                else if (event.type === 'reasoning-delta') { thoughts.push(event.text); emit({ type: 'reasoning', text: event.text }) }
                else if (event.type === 'tool-call' && !spec) emit({ type: 'tool-call', call: { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, ...(event.invalid ? { invalid: event.error?.message || '参数无法解析，或这个工具不存在' } : {}) } })
                else if (event.type === 'error') failure = event.error            // 供应商自己报的错是一个事件，不接住会被当成正常回答。
            }
            if (failure) throw failure                                            // 带着 statusCode 等字段先抛，别被换成丢了字段的二次错误。
            flush(true)                                                           // 文字工具模式：把扣着、最后证明不是调用的正文补推。
            if (await running.finishReason === 'error') throw new Error('模型请求失败：供应商返回了错误但没有给出原因')
            const toolCalls = await running.toolCalls
            // 正文 / 思考全文就是推送过的片段拼起来（AI SDK 的 text / reasoningText 也是这样拼的），宿主拿它逐字核对。
            return { text: parts.join(''), reasoning: thoughts.join(''), toolCalls, usage: await running.usage, messages: await running.responseMessages, output: call.output && !toolCalls.length ? await running.output : undefined }
        }, { ...request.retry, signal: request.signal, onRetry: request.onRetry })

        // --- 4. 文字工具：从回复文字里读回调用，改写成和原生调用完全一样的形状（history 只有一种格式）---
        let text = result.text ?? ''
        // AI SDK 标记 invalid 的调用：input 可能是原始字符串或没过 schema 的对象，原因在 error 里——保留下来交给 loop 拒绝执行。
        let toolCalls: ToolCall[] = (result.toolCalls ?? []).map((one: any) => ({
            toolCallId: one.toolCallId, toolName: one.toolName, input: one.input,
            ...(one.invalid ? { invalid: one.error?.message || '参数无法解析，或这个工具不存在' } : {}),
        }))
        let replyMessages = (result.messages ?? []) as ModelMessage[]
        if (spec) {
            const parsed = parse(text, spec)
            if (parsed.calls.length) {
                text = parsed.text
                toolCalls = parsed.calls
                // 只替换 assistant 里的文字块，思考等其它块原样保留。
                const assistant = [...replyMessages].reverse().find(message => message.role === 'assistant')
                const kept = assistant && Array.isArray(assistant.content) ? (assistant.content as any[]).filter(part => part.type !== 'text' && part.type !== 'tool-call') : []
                const content = [...kept, ...(text ? [{ type: 'text', text }] : []), ...toolCalls.map(({ invalid: _invalid, ...call }) => ({ type: 'tool-call', ...call }))] // invalid 只给 loop 看，不进 history。
                replyMessages = [...replyMessages.filter(message => message !== assistant), { role: 'assistant', content } as ModelMessage]
            }
            if (stream) for (const call of toolCalls) emit({ type: 'tool-call', call }) // 正文已经边收边推过了，这里只补调用。
        }

        // --- 5. 用量补齐五个字段：各家给的不一定齐全，缺的按 0，不让 undefined 把宿主的合计变成 NaN ---
        const raw = (result.usage ?? {}) as Record<string, any>
        const usage: Usage = {
            inputTokens: raw.inputTokens ?? 0,
            outputTokens: raw.outputTokens ?? 0,
            totalTokens: raw.totalTokens ?? (raw.inputTokens ?? 0) + (raw.outputTokens ?? 0),
            cacheReadTokens: raw.inputTokenDetails?.cacheReadTokens ?? raw.cachedInputTokens ?? 0,
            cacheWriteTokens: raw.inputTokenDetails?.cacheWriteTokens ?? 0,
        }
        if (stream) emit({ type: 'finish', usage })
        // 只留 assistant 消息：tool 消息由 loop 用真实执行结果生成。
        const assistantOnly = replyMessages.filter(message => message.role === 'assistant')
        return { text, reasoning: result.reasoning ?? '', toolCalls, usage, messages: assistantOnly, ...(result.output !== undefined ? { output: result.output } : {}) }
    } catch (error) {
        classify(error)                                                           // 退避等待期被取消等路径也保证带 kind。
        throw error
    }
}
