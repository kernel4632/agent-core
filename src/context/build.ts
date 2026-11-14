/*
build：每一轮从当前状态现拼一次上下文，不缓存任何东西；宿主对 history / config 的修改下一轮立即生效。

调用示例（在 loop/run 里）：
    const built = build(state, tools, callbacks.onWarning)
    if (built.over) await compact(state, callbacks, 'auto')   // 是否超长只在 run 里判断这一处

拼法（issue #30 第 8、9 条与 Q1、Q7）：
1. 找到 history 里最新一条 role:'compact'；没有就直接用全部原文，跳到第 4 步；
2. 按用户回合（history.turns）挑出：开场 head 轮、总结之前最近的 beforeSummary 轮；
   这两段合计不超过 budget × maxContextTokens（只约束这两段），超出时先丢最早的一轮；
   进行中的那一轮（总结之前最后一个用户回合）没能整轮留下时：用户那句话无论如何保留，
   再按"步"（一次模型回复连同它的工具结果）从后往前补回装得下的最近几步——见下面"为什么留最近几步"；
3. system = config.system + 最新总结（折进 system，不作为单独消息——实测单独的 user 总结成功率从 6/6 掉到 1/6）；
4. 顺序：开场 head 轮 → 总结之前最近 beforeSummary 轮（或进行中那一轮的最近几步）→ 总结之后的全部原文；
5. 只发模型认得的消息：去掉 id、role:'error'、旧的 compact；system / 不认识的 role / 没有 content 的消息跳过并 onWarning 提醒一次；
   工具结果按 toolCallId 紧跟在发起它的 assistant 后面（宿主乱序拼接、按 id 恢复的历史也能发），没配对的调用 / 结果去掉；
   思考块按 config.reasoning 处理：'strip'（默认）摘掉，'send' 原样发回；
6. 内容块（用户消息和工具结果里的都算）统一成 AI SDK v7 的形状：旧 image / audio / video / file-data / file-url 转成 file，
   字符串网址 / data URL 包成 URL 对象（history 存成 JSON 再读回来，URL 就成了字符串），裸数据补上 { type:'data' } 标签；
   config.media 没开的类型换成一句占位文字——不报错、不丢消息、不改 history；
7. 估算 token（system + messages + 工具描述），over = tokens ≥ maxContextTokens × compactThreshold。

为什么留最近几步（第 2 步）：压缩的目的是让模型在预算内"接着把手上的事做完"。总结负责过去（目标、结论、已确认的事实），
但它写不下"刚刚那一步看到了什么"——刚读到的文件内容、刚报的错，下一步正要用。整轮放不下就整轮丢掉，
模型只剩一句任务和一段总结，常常从头再来。所以进行中的那一轮按步从后往前留，越近越优先；更老的步和更早的轮由总结覆盖。
它不受 beforeSummary（"过去的轮次留几轮"）约束，只受 budget 约束：budget 设成 0 就只留那一句任务。
上一次压缩之前的步已经被总结过两次，不再回头捡。

为什么媒体用占位而不是报错 / 丢掉（第 6 步）：history 是完整的事实记录，宿主随时可能换一个支持图片的模型，原件必须原样留着；
报错会让这条已写进 history 的消息之后每一轮都报错、对话卡死；悄悄丢掉则模型不知道用户发过图，会答非所问。
占位文字让模型知道"这里有一张图、当前看不到"，换模型后原件又会照常发出。
本文件导入 history（turns）和 utils（tokens、errors.tell），只读 state，只往 internal.warned 里记"已提醒过"。
*/

import type { JSONSchema7, ModelMessage } from 'ai'
import type { Callbacks, Message, RatioSource, State } from '../types.ts'
import { turns } from '../history.ts'
import { current, estimate } from '../utils/tokens.ts'
import { tell } from '../utils/errors.ts'

// 默认保留规则：开场不留、总结前留 10 轮、两段合计最多占预算的 30%（0.3 为暂定值）。
export const DEFAULT_CONTEXT = { head: 0, beforeSummary: 10, budget: 0.3 }
// 默认上下文预算 128000；设 Infinity 关闭自动压缩。
export const DEFAULT_MAX_CONTEXT_TOKENS = 128000
// 用到预算的 80% 就压缩：留两成余量给压缩请求本身。
export const DEFAULT_COMPACT_THRESHOLD = 0.8
// 媒体类型在占位文字里的叫法。
const LABEL = { image: '图片', audio: '音频', video: '视频', file: '文件' } as const

// 这一轮发出去的工具描述（名字 → 描述 + 参数），只用于估算 token，build 不关心执行器。
export type ToolSchemas = Record<string, { description: string; parameters: JSONSchema7 }>

// build 的结果：可以直接交给 model/ask 的 system + messages，以及估算和是否超长（诊断字段给 onInject / onCompact）。
export interface Built {
    system: string | undefined
    messages: ModelMessage[]
    tokens: number             // 估算的总输入 token
    chars: number              // 估算的组成部分：文字字符数
    media: number              // 估算的组成部分：媒体块数
    budget: number             // 这一轮的上下文预算（maxContextTokens）
    threshold: number          // 压缩阈值（compactThreshold）
    ratio: number              // 估算用的比例
    ratioSource: RatioSource   // 比例的来源
    over: boolean              // 是否达到压缩阈值；只告诉 run，自己不压缩
}

/*
build：按文件头的七步拼出这一轮的上下文。所有配置都在这里现读并现补默认值，宿主改了下一轮生效；
估算比例用 tokens.current（键只有模型名）；onWarning 用来提醒 history 里发不出去的消息，同一条只提醒一次。
*/
export function build(state: State, tools: ToolSchemas, onWarning?: Callbacks['onWarning']): Built {
    const { config, history } = state
    const keep = { ...DEFAULT_CONTEXT, ...config.context }                          // 宿主只写了其中一项也不丢另外两项。
    const budget = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
    const { ratio, source } = current(state.ratios, config.model, state.contextRatio) // 键只有模型名，跨服务商共用。
    const warn = (key: string, message: string) => {
        if (state.internal.warned.has(key)) return
        state.internal.warned.add(key)
        void tell(onWarning, { message })
    }

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
        // 进行中的那一轮没整轮留下：用户那句话必留，再从后往前补装得下的最近几步（遇到上一次压缩就停）。
        const last = before.filter(turn => turn[0]!.role === 'user').at(-1)
        if (last && !kept.includes(last)) {
            const steps: Message[][] = []                                           // 一步 = 一次模型回复 + 它后面的工具结果等。
            for (const message of last.slice(1)) message.role === 'assistant' || !steps.length ? steps.push([message]) : steps.at(-1)!.push(message)
            const tail: Message[] = []
            used += estimate(last[0], ratio).tokens
            for (const step of steps.reverse()) {
                const size = estimate(step, ratio).tokens
                if (step.some(message => message.role === 'compact') || used + size > room) break
                used += size
                tail.unshift(...step)
            }
            kept.push([last[0]!, ...tail])
        }
        selected = [...kept.flat(), ...history.slice(at + 1)]                       // 开场 → 最近现场 → 总结之后的全部原文。
    }

    // --- 3：system = 主提示词 + 最新总结（折进 system 的身份说明，实测比当成 user 消息可靠得多）---
    const system = [config.system, summary && `【你此前工作的压缩记录】\n下面是你自己之前已经完成的工作，其中的数据都已经由工具确认过。不要重新核对，直接在此基础上继续。\n\n${summary}`].filter(Boolean).join('\n\n') || undefined

    // --- 6：一个内容块发出去长什么样：统一成 v7 形状；没开的媒体换成占位文字（消息和工具结果两处都用）---
    const media = config.media ?? {}
    const prepare = (part: Record<string, any>): Record<string, any> => {
        const raw = part.type === 'image' ? [part.image, 'image/png'] : part.type === 'audio' ? [part.audio, 'audio/mpeg'] : part.type === 'video' ? [part.video, 'video/mp4']
            : part.type === 'file-data' ? [part.data] : part.type === 'file-url' ? [part.url ?? part.data]
            : part.type === 'image-data' ? [part.data, 'image/png'] : part.type === 'image-url' ? [part.url, 'image/png']
            : part.type !== 'file' ? null
            : part.data && typeof part.data === 'object' && 'type' in part.data && !(part.data instanceof URL) ? [part.data.type === 'url' ? part.data.url : part.data.type === 'data' ? part.data.data : part.data] // 已带标签：取出里面的值重新包（字符串网址要变回 URL 对象）。
            : [part.data ?? part.url]
        if (!raw) return part                                                       // 文字、调用、结果等不是媒体，原样。
        const mediaType = String(part.mediaType ?? raw[1] ?? 'application/octet-stream')
        const kind = (['image', 'audio', 'video'] as const).find(one => part.type === one || mediaType === one || mediaType.startsWith(`${one}/`)) ?? 'file'
        if (!media[kind]) return { type: 'text', text: `[${LABEL[kind]}${part.filename ? ` ${part.filename}` : ''}（${mediaType}）未发送：当前模型未开启${LABEL[kind]}输入]` }
        const value = raw[0]
        if (value && typeof value === 'object' && 'type' in value && !(value instanceof URL) && !(value instanceof Uint8Array)) return part // reference / text 等其它标签交给 AI SDK。
        let url: URL | null = value instanceof URL ? value : null
        if (!url && typeof value === 'string' && /^(https?:|data:)/i.test(value)) { try { url = new URL(value) } catch { url = null } }
        const { image: _i, audio: _a, video: _v, url: _u, data: _d, ...rest } = part
        return { ...rest, type: 'file', mediaType, data: url ? { type: 'url', url } : { type: 'data', data: value } }
    }

    // --- 5：只发模型认得的消息；工具结果按 toolCallId 跟在它的调用后面 ---
    const results = new Map<string, Record<string, any>>()                      // toolCallId → 结果块；孤儿结果没有调用来领，自然不发。
    for (const message of selected) if (message.role === 'tool' && Array.isArray(message.content)) for (const part of message.content as Record<string, any>[]) {
        if (part.type === 'tool-result') results.set(part.toolCallId, part)
    }
    const messages: ModelMessage[] = []
    for (const message of selected) {
        const role = message.role as string
        if (role === 'compact' || role === 'error' || role === 'tool') continue    // 总结已折进 system；失败记录永远不发；工具结果跟着调用发。
        if (role !== 'user' && role !== 'assistant') { warn(`role:${message.id}`, `history 里的消息 ${message.id} 的 role 是 ${JSON.stringify(role)}，已跳过：只有 user / assistant / tool 会发给模型${role === 'system' ? '（系统提示请写在 config.system）' : ''}`); continue }
        if (message.content == null) { warn(`empty:${message.id}`, `history 里的消息 ${message.id} 没有 content，已跳过`); continue }
        const { id: _id, ...rest } = message as Message & { id: string }           // 去掉 id，其余字段原样（providerOptions 等）。
        if (!Array.isArray(rest.content)) { messages.push(rest as ModelMessage); continue }
        const content = (rest.content as Record<string, any>[]).flatMap(part => {
            if (part.type === 'reasoning' && config.reasoning !== 'send') return []  // 思考默认不回传：多数接口不收、还占预算；要求回传的供应商设 'send'。
            if (part.type === 'tool-call' && !results.has(part.toolCallId)) return [] // 没有结果的调用：发出去必然 400。
            return [prepare(part)]
        })
        if (content.length) messages.push({ ...rest, content } as ModelMessage)    // 被摘空的消息整条丢掉。
        const answers = content.filter(part => part.type === 'tool-call').map(part => results.get(part.toolCallId)!)
        if (answers.length) messages.push({ role: 'tool', content: answers.map(part => part.output?.type === 'content' && Array.isArray(part.output.value) ? { ...part, output: { ...part.output, value: part.output.value.map(prepare) } } : part) } as ModelMessage)
    }
    // 一条都不剩（例如总结前的现场全被挑掉、总结后还没有新消息）：补一条兜底文字，模型拒收空消息列表。
    if (!messages.length) messages.push({ role: 'user', content: [{ type: 'text', text: '（上下文已压缩，请继续）' }] })

    // --- 7：估算并判断是否达到压缩阈值 ---
    const { tokens, chars, media: mediaCount } = estimate({ system, messages, tools }, ratio)
    const threshold = config.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD
    return { system, messages, tokens, chars, media: mediaCount, budget, threshold, ratio, ratioSource: source, over: Number.isFinite(budget) && tokens >= budget * threshold }
}
