/*
总结的"请求"和"包装"：只负责拼出让模型写总结的请求、把总结文字包成一条 history 消息。

调用示例（在 loop/compact 里）：
    const request = summarize.request(built.messages, state.config)   // 交给 model/ask
    const reply = await ask(request)
    append(state.history, summarize.wrap(reply.text))

为什么拆成 request / wrap 两半、自己不调模型：summarize 如果导入 model/ask，就成了 context → model 的
跨目录同级导入。由 loop 负责"拼请求 → 问模型 → 包装 → 追加"，这里只剩纯函数，不导入任何本项目文件。
*/

import type { AskRequest, CompactMessage, Config, Draft } from '../types.ts'
import type { ModelMessage } from 'ai'

// 让模型写总结的固定指令：要求保留目标、已完成的步骤、关键事实和下一步，便于压缩后接着干活。
export const SUMMARY_PROMPT = '请把以上对话压缩成一份总结，保留：用户的目标、已经完成的步骤与结果、关键事实与约束、尚未完成的下一步。只输出总结本身。'

/*
request：把当前上下文变成一次"写总结"的问模型请求。

- messages 是 context/build 现拼的上下文（已经是最新总结 + 之后原文的形状），末尾追加 SUMMARY_PROMPT；
- 连接参数优先取 config.compact 里的（压缩可以用更便宜的模型），没写的沿用主配置；
- 不带工具、不开文字工具、不要结构化输出：总结请求只要一段文字；
- 重试参数照搬主配置（retryMaxTries 等收拢成 RetryOptions）。
*/
export function request(messages: ModelMessage[], config: Config): AskRequest {
    throw new Error('TODO')
}

/*
wrap：把模型写好的总结文字包成一条 role:'compact' 的草稿，交给 history.append 补 id 后追加。
空总结直接抛错：写进去一条空总结会让之后的上下文丢掉全部前情。
*/
export function wrap(text: string): Draft & Omit<CompactMessage, 'id'> {
    throw new Error('TODO')
}
