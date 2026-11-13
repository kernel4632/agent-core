/*
总结的"请求"和"包装"：只负责拼出让模型写总结的请求、把总结文字包成一条 history 消息。

调用示例（在 loop/compact 里）：
    const request = summarize.request(built, state.config)   // 交给 model/ask
    const reply = await ask(request)
    append(state.history, summarize.wrap(reply.text))

为什么拆成 request / wrap 两半、自己不调模型：summarize 如果导入 model/ask，就成了 context → model 的
跨目录同级导入。由 loop 负责"拼请求 → 问模型 → 包装 → 追加"，这里只剩纯函数，只导入 utils/retry 的参数收拢。
*/

import type { AskRequest, CompactMessage, Config } from '../types.ts'
import type { ModelMessage } from 'ai'
import { options } from '../utils/retry.ts'

// 让模型写总结的固定指令：要求保留目标、已完成的步骤、关键事实和下一步，便于压缩后接着干活。
// 指令说清楚"留什么、丢什么"，模型才知道这份总结是拿来接着干活的，不是拿来复述的（沿用旧实现的措辞）。
export const SUMMARY_PROMPT = `请把以上对话压缩成一段总结，供你自己后续继续工作时使用。
保留：已经确认的事实与数据、已完成的步骤及其结论、还没做完的事、用户最初的目标。
丢弃：寒暄、重复的中间过程、已经被后续结果推翻的内容。
只输出总结本身，不要说"好的"，不要继续对话。`

/*
request：把当前上下文变成一次"写总结"的问模型请求。

- messages 是 context/build 现拼的上下文（已经是最新总结 + 之后原文的形状），末尾追加 SUMMARY_PROMPT；
  原样作为 messages 发出，不 JSON.stringify 成一条消息：二次转义会让压缩请求比它要压的上下文还大（实测 1.51 倍）；
- built.system 里折着主提示词和上一次的总结，作为背景并进压缩专用的 system——丢掉它，第二次压缩就看不到第一次总结过的事实；
- 连接参数优先取 config.compact 里的（压缩可以用更便宜的模型），没写的沿用主配置；
- 不带工具、不开文字工具、不要结构化输出：总结请求只要一段文字；
- 重试参数照搬主配置（retryMaxTries 等收拢成 RetryOptions）。
*/
export function request(built: { system?: string; messages: ModelMessage[] }, config: Config): AskRequest {
    const merged = { ...config, ...config.compact }                      // 压缩专用的模型 / 参数覆盖主配置。
    const system = ['你在压缩一段你自己参与过的工作记录。只输出总结内容本身。', built.system && `下面是这段工作的背景设定和此前的压缩记录，新总结必须保留其中仍然有效的事实：\n\n${built.system}`].filter(Boolean).join('\n\n')
    return {
        model: merged.model, baseURL: merged.baseURL, apiKey: merged.apiKey, protocol: merged.protocol,
        cache: merged.cache, provider: merged.provider, maxTokens: merged.maxTokens, stream: merged.stream,
        system,
        messages: [...built.messages, { role: 'user', content: SUMMARY_PROMPT }],
        retry: options(merged),
    }
}

/*
wrap：把模型写好的总结文字包成一条 role:'compact' 的草稿，交给 history.append 补 id 后追加。
空总结直接抛错：写进去一条空总结会让之后的上下文丢掉全部前情。
*/
export function wrap(text: string): Omit<CompactMessage, 'id'> {
    const content = typeof text === 'string' ? text.trim() : ''
    if (!content) throw new Error('压缩失败：模型返回空总结')
    return { role: 'compact', content }
}
