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
import type { Message, State } from '../types.ts'
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
    const { config, history } = state
    const keep = { ...DEFAULT_CONTEXT, ...config.context }                          // 宿主只写了其中一项也不丢另外两项。
    const budget = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
    const ratio = current(state.ratios, config.model, state.contextRatio)           // 键只有模型名，跨服务商共用。

    // --- 1~4：按最新总结切分并挑选 ---
    const at = history.findLastIndex(message => message.role === 'compact')         // 多次压缩后只有最后一条算数。
    let selected: Message[] = history                                               // 没压缩过：完整历史就是最准确的上下文。
    let summary = ''
    if (at >= 0) {
        summary = (history[at] as { content: string }).content
        const before = turns(history.slice(0, at))                                  // 最新总结已经覆盖的范围，只在这里面挑。
        const covered = before.findLastIndex(turn => turn.some(message => message.role === 'compact')) // 上一条总结所在回合：更老的原文已被总结两次。
        const head = before.filter(turn => turn[0]!.role === 'user').slice(0, keep.head)              // 开场 head 个用户回合。
        const pool = before.slice(covered + 1).filter(turn => turn[0]!.role === 'user' && !head.includes(turn)) // 上一条总结之后、没被开场选走的用户回合。
        const recent = keep.beforeSummary > 0 ? pool.slice(-keep.beforeSummary) : []   // 总结前最近 beforeSummary 个（0 = 一个不留）。
        // 两段按时间顺序排好，合计超过 budget × 预算时从最早的一轮开始丢。预算无限（Infinity）时不丢。
        const kept = before.filter(turn => head.includes(turn) || recent.includes(turn))
        const room = Number.isFinite(budget) ? keep.budget * budget : Infinity
        let used = kept.reduce((total, turn) => total + estimate(turn, ratio).tokens, 0)
        while (kept.length && used > room) used -= estimate(kept.shift()!, ratio).tokens
        selected = [...kept.flat(), ...history.slice(at + 1)]                       // 开场 → 最近现场 → 总结之后的全部原文。
    }

    // --- 3：system = 主提示词 + 最新总结（折进 system 的身份说明，实测比当成 user 消息可靠得多）---
    const system = [config.system, summary && `【你此前工作的压缩记录】\n下面是你自己之前已经完成的工作，其中的数据都已经由工具确认过。不要重新核对，直接在此基础上继续。\n\n${summary}`].filter(Boolean).join('\n\n') || undefined

    // --- 5：去掉只给宿主看的东西，并保证工具调用与结果成对（宿主手改 history 时也不至于发出 400）---
    const called = new Set<string>(), answered = new Set<string>()
    for (const message of selected) if (Array.isArray(message.content)) for (const part of message.content as Record<string, any>[]) {
        if (part.type === 'tool-call') called.add(part.toolCallId)
        if (part.type === 'tool-result') answered.add(part.toolCallId)
    }
    const media = config.media ?? {}
    const messages: ModelMessage[] = []
    for (const message of selected) {
        if (message.role === 'compact' || message.role === 'error') continue        // 总结已折进 system；失败记录永远不发。
        const { id, ...rest } = message as Message & { id: string }                 // 去掉 id，其余字段原样（providerOptions 等）。
        if (!Array.isArray(rest.content)) { messages.push(rest as ModelMessage); continue }
        const content = (rest.content as Record<string, any>[]).flatMap(part => {
            if (part.type === 'reasoning') return []                                 // 思考内容默认不回传：多数接口不收、还占预算。
            if (part.type === 'tool-call' && !answered.has(part.toolCallId)) return [] // 没有结果的调用：发出去必然 400。
            if (part.type === 'tool-result' && !called.has(part.toolCallId)) return [] // 孤儿结果同理。
            // --- 6：媒体按开关处理；file 按 mediaType 判断是图片 / 音频 / 视频还是普通文件 ---
            const kind = part.type === 'image' ? 'image' : part.type === 'file' ? (['image', 'audio', 'video'].find(one => String(part.mediaType).startsWith(`${one}/`)) ?? 'file') : null
            if (kind && !media[kind as keyof typeof media]) {
                if (config.mediaFallback === 'strip') return []
                throw new TypeError(`当前模型未启用 ${kind} 内容；设置 config.media.${kind} = true，或使用 mediaFallback: 'strip'`)
            }
            return [part]
        })
        if (content.length) messages.push({ ...rest, content } as ModelMessage)    // 被摘空的消息整条丢掉。
    }
    // 摘空之后一条都不剩（例如只发了一张被 strip 的图）：补一条兜底文字，模型拒收空消息列表。
    if (!messages.length) messages.push({ role: 'user', content: [{ type: 'text', text: '（上下文已压缩，请继续）' }] })

    // --- 7：估算并判断是否达到压缩阈值 ---
    const { tokens, chars, media: mediaCount } = estimate({ system, messages, tools }, ratio)
    const threshold = config.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD
    return { system, messages, tokens, chars, media: mediaCount, budget, ratio, over: Number.isFinite(budget) && tokens >= budget * threshold }
}
