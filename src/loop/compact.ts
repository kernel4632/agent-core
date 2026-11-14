/*
compact：整个项目唯一的压缩逻辑（取代旧实现的三个同名 compact），一个函数从头做到尾。只负责压缩，不判断要不要压。

调用示例：
    const { summary, usage } = await compact(state, callbacks, 'auto')   // loop/run：估算到阈值，或模型报超长（'overflow'）
    const { summary } = await compact(state, callbacks, 'manual')        // agent.compact()：宿主点"压缩"

步骤：
1. context/build 现拼当前上下文（已经是"最新总结 + 之后原文"的形状），同时拿到压缩前的估算诊断；
2. 拼"写总结"的请求：
   - messages = 当前上下文 + 末尾一条 SUMMARY_PROMPT；原样作为 messages 发出，不 JSON.stringify 成一条消息
     （二次转义会让压缩请求比它要压的上下文还大，实测 1.51 倍）；
   - system = 压缩专用的身份说明 + 当前上下文的 system（折着主提示词和上一次总结）作为背景——
     丢掉它，第二次压缩就看不到第一次总结过的事实；
   - 连接参数优先取 config.compact 里的（压缩可以用更便宜的模型），没写的沿用主配置；重试参数照搬（utils/retry.options）；
   - 不传 maxTokens：那是给正式回答设的上限，思考模型会把大半花在思考上，总结被截断却照样写进 history（实录）；
     压缩一律用模型自己的上限，长度靠 SUMMARY_PROMPT 约束；
   - 不带工具、不开文字工具、不要结构化输出：只要一段文字；provider 原样带上，只对工具有意义的 toolChoice
     由 model/configure 按"这一笔没带工具"的通用规则去掉，这里不特殊处理；
3. model/ask 问模型：开始前发一条 onChunk({ type: 'compact-start' })，压缩模型的思考 / 正文 / finish 片段带上 compact: true
   实时转给 onChunk（宿主能看到压缩时模型在想什么、总结正文是什么，又不会和正式回答混在一起）；
   是否流式跟随 config.compact.stream ?? config.stream（默认流式），非流式时只有 compact-start；
   出错和主请求同一条规则：每次重试前、最终失败都追加一条 role:'error'（request 里带 compact: true），相同的不重复，取消不记；
4. 空总结直接抛错：写进去一条空总结会让之后的上下文丢掉全部前情；否则以 role:'compact' 追加进 history；
5. 发 onCompact（reason、总结正文、压缩前后估算及其诊断、用量），返回总结文字和这一笔请求的用量（run 要把它计进合计）。

reason：'manual' 来自宿主的 agent.compact()；'auto' 来自 run 的阈值判断（估算到了 compactThreshold）；
'overflow' 来自模型报上下文超长后的强制压缩（说明估算偏小，宿主排查时要分开看）。

为什么放在 loop 而不是 context：压缩要问模型、要写 history，问模型是 model 的能力，写 history 只有 loop 能做；
放在 context 就得拆成"拼请求 / 包装"两半由 loop 串起来（旧的 context/summarize），一件事被切成三处。
导入：context/build、model/ask、history（append）、utils/errors（explain、tell）、utils/retry（options）。全部向下。
*/

import type { Callbacks, CompactReason, State, Usage } from '../types.ts'
import { build } from '../context/build.ts'
import { ask } from '../model/ask.ts'
import { append } from '../history.ts'
import { explain, tell } from '../utils/errors.ts'
import { options } from '../utils/retry.ts'

// 让模型写总结的固定指令：要求保留目标、已完成的步骤、关键事实和下一步，便于压缩后接着干活。
// 指令说清楚"留什么、丢什么"，模型才知道这份总结是拿来接着干活的，不是拿来复述的（沿用旧实现的措辞）。
export const SUMMARY_PROMPT = `请把以上对话压缩成一段总结，供你自己后续继续工作时使用。
保留：已经确认的事实与数据、已完成的步骤及其结论、还没做完的事、用户最初的目标。
丢弃：寒暄、重复的中间过程、已经被后续结果推翻的内容。
只输出总结本身，不要说"好的"，不要继续对话。`

/*
compact：按文件头的五步压缩一次。signal 取当前运行的取消器（stop() 能打断压缩）；
reason 默认 'manual'。压缩失败（含空总结）直接抛出，history 不会被写进半截东西。
*/
export async function compact(state: State, callbacks: Callbacks = {}, reason: CompactReason = 'manual'): Promise<{ summary: string; usage: Usage }> {
    const signal = state.internal.controller?.signal
    const before = build(state, {}, callbacks.onWarning)
    const merged = { ...state.config, ...state.config.compact }          // 压缩专用的模型 / 参数覆盖主配置。
    const system = ['你在压缩一段你自己参与过的工作记录。只输出总结内容本身。', before.system && `下面是这段工作的背景设定和此前的压缩记录，新总结必须保留其中仍然有效的事实：\n\n${before.system}`].filter(Boolean).join('\n\n')
    const name = typeof merged.model === 'string' ? merged.model : (merged.model as { modelId?: string }).modelId
    const record = (error: unknown, attempt?: number) => {
        const draft = signal?.aborted ? null : explain(error, { model: name, protocol: merged.protocol ?? 'chat', compact: true, ...(attempt ? { attempt } : { final: true }) })
        if (draft) append(state.history, draft)
    }
    void tell(callbacks.onChunk, { type: 'compact-start', reason, compact: true })
    const reply = await ask({
        model: merged.model, baseURL: merged.baseURL, apiKey: merged.apiKey, protocol: merged.protocol,
        cache: merged.cache, provider: merged.provider, stream: merged.stream, includeUsage: merged.includeUsage,
        reasoning: merged.reasoning,                                     // before.messages 已按主配置摘过；压缩模型另有要求时由 ask 再处理一次。
        system,
        messages: [...before.messages, { role: 'user', content: SUMMARY_PROMPT }],
        retry: options(merged), signal,
        onRetry: info => { record(info.error, info.attempt); return callbacks.onRetry?.(info) },
    }, chunk => tell(callbacks.onChunk, { ...chunk, compact: true })).catch(error => { record(error); throw error })
    const summary = typeof reply.text === 'string' ? reply.text.trim() : ''
    if (!summary) throw new Error('压缩失败：模型返回空总结')
    append(state.history, { role: 'compact', content: summary })
    const { budget, threshold: compactThreshold, ratio, ratioSource, chars, media } = before
    void tell(callbacks.onCompact, { reason, summary, before: before.tokens, after: build(state, {}).tokens, budget, compactThreshold, ratio, ratioSource, chars, media, usage: reply.usage })
    return { summary, usage: reply.usage }
}
