/*
build：每一轮从当前状态现拼一次上下文，不缓存任何东西；宿主对 history / config 的修改下一轮立即生效。

调用示例（在 loop/run 里）：
    const built = build(state, tools)
    if (built.over) await compact(state, callbacks, 'auto')   // 是否超长只在 run 里判断这一处

拼法（issue #30 第 8、9 条与 Q1、Q7）：
1. 找到 history 里最新一条 role:'compact'；没有就直接用全部原文，跳到第 4 步；
2. 按用户回合（history.turns）挑出：开场 head 轮、总结之前最近的 beforeSummary 轮；
   这两段合计不超过 budget × maxContextTokens（只约束这两段），超出时先丢最早的一轮；
3. system = config.system + 最新总结（折进 system，不作为单独消息——实测单独的 user 总结成功率从 6/6 掉到 1/6）；
4. 顺序：开场 head 轮 → 总结之前最近 beforeSummary 轮 → 总结之后的全部原文；
5. 去掉发给模型不需要的东西：每条消息的 id、全部 role:'error'、旧的 compact 消息；
6. 按 config.media 处理媒体块：没开的类型，mediaFallback 'strip' 就只留文字，'error'（默认）就抛错说明怎么打开；
7. 估算 token（system + messages + 工具描述），over = tokens ≥ maxContextTokens × compactThreshold。

build 只负责"挑选和拼接"，不做消息格式转换：history 里存的本来就是 AI SDK 标准消息（只转一次的问题因此消失）。
本文件只导入 history（向上一级的同级模块不导入）和 utils/tokens。
*/

import type { JSONSchema7, ModelMessage } from 'ai'
import type { State } from '../types.ts'
import { turns } from '../history.ts'
import { current, estimate } from '../utils/tokens.ts'

// 默认保留规则：开场不留、总结前留 10 轮、两段合计最多占预算的 30%（0.3 为暂定值）。
export const DEFAULT_CONTEXT = { head: 0, beforeSummary: 10, budget: 0.3 }
// 默认上下文预算 128000；设 Infinity 关闭自动压缩。
export const DEFAULT_MAX_CONTEXT_TOKENS = 128000
// 用到预算的 80% 就压缩：留两成余量给压缩请求本身。
export const DEFAULT_COMPACT_THRESHOLD = 0.8

// 这一轮发出去的工具描述（名字 → 描述 + 参数），只用于估算 token，build 不关心执行器。
export type ToolSchemas = Record<string, { description: string; parameters: JSONSchema7 }>

// build 的结果：可以直接交给 model/ask 的 system + messages，以及估算和是否超长。
export interface Built {
    system: string | undefined
    messages: ModelMessage[]
    tokens: number      // 估算的总输入 token
    chars: number       // 估算的组成部分：文字字符数
    media: number       // 估算的组成部分：媒体块数
    budget: number      // 这一轮的上下文预算（maxContextTokens）
    ratio: number       // 估算用的比例，onInject / 诊断用
    over: boolean       // 是否达到压缩阈值；只告诉 run，自己不压缩
}

/*
build：按文件头的七步拼出这一轮的上下文。

- 所有配置都在这里现读并现补默认值（config.context ?? DEFAULT_CONTEXT 等），宿主改了下一轮生效；
- 估算比例用 tokens.current(state.ratios, config.model, state.contextRatio)，键只有模型名；
- 只读 state，不写 history，不写 ratios（校准由 run 在拿到真实 usage 后做）。
*/
export function build(state: State, tools: ToolSchemas): Built {
    throw new Error('TODO')
}
