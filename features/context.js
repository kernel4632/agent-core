/*
目标被调用形式（绝对不可修改）：
const { messages, token } = Context.build({
    history: agent.history,        // 完整历史；Context.build 只读，不修改
    system: "你是编程助手。",     // 会进入 messages 并参与 Token 估算
    tools: {},                    // 工具定义参与 Token 估算，不进入 messages
    budget: 120000,               // 可选。上下文的 Token 预算，用来决定保留多少旧内容
})

build() 只读 history，从不修改它。history 是唯一权威数据来源，
裁剪只发生在"这一次交给模型的内容"上。

裁剪的最小单位是「回合」，不是「消息」。
build() 一进来就把平铺历史读成回合：工具结果按 toolCallId 回到发起它的那个回合，
不靠"它排在谁后面"这种位置关系。于是 tool-call 和 tool-result 是同一个数组里的邻居，
"把配对切断"这个动作在结构上不存在——裁剪只能整个回合留下、或整个回合丢掉，
怎么裁都是若干完整回合的拼接，OpenAI / Anthropic / Gemini 都能直接收下。

平铺 history                      回合（Context 内部唯一使用的形状）
0 user      帮我重构项目    →     [ user ]                             ← 最初目标
1 assistant tool-call A、B  →     [ assistant(A,B), tool A, tool B ]   ← 并行调用和它们的结果同属一个回合
2 tool      result A        ↗
3 tool      result B        ↗
4 user      总结(compact)   →     [ compact ]                          ← 总结自成一个回合
5 assistant tool-call C     →     [ assistant(C), tool C ]
6 tool      result C        ↗

有总结时，最新那条总结不是当成一条消息塞进对话，而是折进 system —— 见下面 brief 的注释。
剩下的 messages 顺序是：最初目标 → 总结前的最近现场 → 总结之后的全部新回合。
*/

import History from './history.js' // 「什么是一个回合」由 History 定义，这里只是它的使用者
import { estimate, DEFAULT_RATIO } from '../utils/tokens.js' // token 估算：字符数 × 每字符 token 比（比例由 Loop 从真实 usage 自校准）

// 开场留住用户最初说过的话（按用户回合数），总结前留住当前任务的最近现场（按回合数）。
// 这两个数字是上限，真正能留多少还要看预算——光按条数留，一条巨大的消息就能让压缩永远收敛不了。
const KEEP_FIRST = 3
const KEEP_BEFORE_SUMMARY = 3

// 旧内容最多能占掉预算的多少。总结之后的新回合不受限——那是当前正在推进的工作，
// 它涨起来是正常的，Loop 会在下一次超阈值时再压一次。
const GOAL_SHARE = 0.2
const RECENT_SHARE = 0.3

// 一个回合有多大。用字符数而不是 token：裁剪要对每个候选回合都量一次，
// 逐条估算 token 是没必要的开销。字符数用来在候选回合之间分预算足够了。
// content 允许缺失（外部恢复的历史可能有），缺了按 0 算，别让 JSON.stringify(undefined).length 抛错。
const size = turn => turn.reduce((total, message) => total + JSON.stringify(message.content ?? null).length, 0)

// --- 在预算内按给定顺序挑回合，装不下就到此为止 ---
const within = (turns, budget) => {
    const picked = []                  // 装得下的回合。
    let used = 0                       // 已经用掉的字符数。
    for (const turn of turns) {
        used += size(turn)
        if (used > budget) break       // 这一条装不下就停，后面的也不看了。
        picked.push(turn)
    }
    return picked
}

// --- 把最新总结折进 system，而不是当成一条消息塞进对话里 ---
// 裸的 role:'user' 总结会被模型读成"用户塞给我一张表"，于是它从头重做整个任务：
// 真实中转站上实测 gpt-oss-120b 有 5/6 概率退回第一步，而且因为它一直在调工具，
// Loop 的两个出口（tool-stop / 连续 noToolRounds 轮不调工具）全都够不着，send() 永不返回、钱一直烧。
// 同一段总结换成下面这个身份说明，同样的模型 6/6 能正确接着往下做。
const brief = (system, summary) => summary
    ? `${system}\n\n【你此前工作的压缩记录】\n下面是你自己之前已经完成的工作，其中的数据都已经由工具确认过。不要重新核对，直接在此基础上继续。\n\n${summary}`.trim()
    : system

// History 只比 AI SDK 多了 id、compact 这些顶层内部字段，兼容规则交给 History.model 集中处理。
// 默认去掉思考和未完成的工具调用；切换到支持它们的模型时只改 capabilities，不改裁剪流程。
const build = ({ history, system = '', tools = {}, budget, ratio = DEFAULT_RATIO, capabilities = {}, mediaFallback = 'error' }) => {
    // --- 还原回合：从这里开始，历史只以回合为单位被处理 ---
    const turns = History.turns(history)                 // 一个回合 = 一次用户发言，或模型的一次响应连同它的工具调用和结果。

    // --- 定位最新总结：从后往前找，多次压缩后只有最后那一条算数 ---
    const summaryIndex = turns.findLastIndex(turn => turn[0].compact === true) // 最后一次压缩留下的那条总结。
    const room = Number.isFinite(budget) ? budget / ratio : Infinity // 旧内容能用的字符预算：token 预算 ÷ 每字符 token 比。没设预算就不限制。
    let selected = turns                                                 // 没有总结时，完整历史就是最准确的上下文。
    let summary = ''                                                     // 有总结时，总结文本折进 system，不占消息位置。

    // --- 有总结时分三段挑：最初目标 + 总结前的最近现场 + 总结之后的全部新回合 ---
    if (summaryIndex >= 0) {                                                                                    // 有过压缩，才开始"挑"；没压缩时用整段历史。
        summary = turns[summaryIndex][0].content                                                                // 总结本身不进 messages，它要折进 system。
        const before = turns.slice(0, summaryIndex)                                                             // 最新总结已经覆盖的范围，裁剪只在这里面挑。
        const covered = before.findLastIndex(turn => turn[0].compact === true)                                  // 上一条总结：比它更老的原文已被总结过两次，不再回头捡。

        // 最初目标：用户自己说过的话，不拖着当时的工具现场。有上限也有预算——
        // 用户第一条消息就粘一大段日志时，光按条数留会让压缩永远收敛不了（实测 120/120 轮压完仍超限）。
        // 超预算时整条不留，不是把目标弄丢了：总结本身就被要求保留"用户最初的目标"（见 Compact 的指令），
        // 而总结在 system 里，永远不会被裁掉。钉在这里的原文只是便宜时的加分项。
        const goal = within(before.filter(turn => turn[0].role === 'user' && !turn[0].compact).slice(0, KEEP_FIRST), room * GOAL_SHARE)

        // 最近现场：从离总结最近的往回收，预算不够就丢更老的——
        // 这样"用户上一轮刚说的那句话"一定在，而不是只剩三天前的开场白。
        const pool = before.slice(Math.max(covered + 1, summaryIndex - KEEP_BEFORE_SUMMARY)).filter(turn => !goal.includes(turn)) // 上一条总结之后的、且没被目标选走的回合。
        const recent = within([...pool].reverse(), room * RECENT_SHARE).reverse()                              // 从最近的往回收，再正回时间顺序。

        // 挑出来的三段（最初目标 / 最近现场 / 总结后的新回合）各自有序，但直接相接会打乱时间顺序：
        // 目标取的是最早的几个用户回合，最近现场取的是靠后的窗口，中间夹着没被选中的、早于目标的回合。
        // 所以最后按 turns 的原始顺序过滤一遍——三段都取自 turns，用引用去重即可。
        const chosen = new Set([...goal, ...recent, ...turns.slice(summaryIndex + 1)])
        // 本次 send 的用户输入无论如何都要在：预算再紧也不能把"正在做的事"剪掉。
        // 一次 send 里连续压缩多次时，它会落到最新总结之前、且可能不在最初目标里、又装不进最近现场的预算，
        // 于是被整条丢掉——模型看不到任务就开始瞎猜。这里按"最后一条用户回合"硬加回来（工具轮不算，那是结果不是指令）。
        const current = before.filter(turn => turn[0].role === 'user' && !turn[0].compact).at(-1)
        if (current) chosen.add(current)
        selected = turns.filter(turn => chosen.has(turn))                                                       // 时间顺序由 turns 本身保证。
    }

    // --- 出口：回合只是 Context 内部的形状，交给模型的仍然是平铺消息 ---
    const flat = selected.flat()                                                                                // 回合内部保持原始顺序，展平后就是一段时间上连续的消息。
    const answered = History.answeredCalls(flat) // 这批消息里真正拿到结果的调用。
    const instructions = brief(system, summary)                                                                 // 系统提示词 + 最新总结。

    const built = [
        ...(instructions ? [{ role: 'system', content: instructions }] : []),                                   // system 进入 messages，并一起参与 Token 估算。
        ...flat.map(message => History.model(message, { answered, capabilities, reasoning: capabilities.reasoning ?? false, mediaFallback, normalizeMedia: false })).filter(message => message.content.length), // 被摘空的消息（只剩思考、媒体或没人应答的调用）整条丢掉。
    ]

    // 摘空之后可能一条非 system 都不剩（用户只发了一张被 strip 掉的图、或压缩后现场全是空回合），
    // 模型拒收"没有消息"的请求，这里补一条兜底文字消息，保证请求发得出去。注意不接受"总结本身当 user 消息"——
    // 那正是折进 system 要避免的（模型会把总结读成用户塞的表、从头重做）。
    const messages = built.some(message => message.role !== 'system')
        ? built
        : [...built, { role: 'user', content: [{ type: 'text', text: '（上下文已压缩，请继续）' }] }]

    // Token 只在真的有人读的时候才算：没设 maxContextTokens 时 Loop 压根不看它。
    // 估算只是一次字符计数（毫秒级），但这份惰性语义保留着，调用方不读就不算。
    let counted
    return {
        messages,                                                            // 这次要发给模型的完整消息。
        get token() {                                                        // 估出来的 token 数，第一次读的时候才算。
            counted ??= estimate({ messages, tools }, ratio)                 // 工具定义不属于 messages，但模型请求仍会携带它们，所以估算时一并计入。
            return counted
        },
    }
}

export default { build }
