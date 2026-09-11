/*
目标被调用形式（绝对不可修改）：
const { messages, token } = Context.build({
    history: History.get(),       // 完整历史
    system: "你是编程助手。",     // 会进入 messages 并参与 Token 估算
    tools: {},                    // 工具定义参与 Token 估算，不进入 messages
})

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

输出顺序固定：最初目标 → 最新总结 → 总结前最近现场 → 总结后全部新回合。
*/

import { countTokens } from 'gpt-tokenizer'

// 开场留住用户最初说过的话（按用户回合数），总结前留住当前任务的最近现场（按回合数）。
const KEEP_FIRST = 3
const KEEP_BEFORE_SUMMARY = 3

// AI SDK 的 content 既可以是内容块数组，也可以是一段纯文本；纯文本里不会有工具调用。
const parts = message => (Array.isArray(message.content) ? message.content : [])

// --- 折叠回合：工具结果认的是发起它的 toolCallId，不是它在数组里的邻居 ---
// 分两趟走：先把回合拼出来、把每个回合欠下的调用登记完，再统一分配工具结果。
// 一趟边填边查会退化成"只有排在调用后面的结果才认得出来"，历史被外部乱序拼接时结果会被悄悄丢掉。
const toTurns = history => {
    const turns = []                                                                    // 回合列表：每个回合是一组永不拆开的消息。
    const caller = new Map()                                                            // toolCallId → 发起它的那个回合，工具结果靠这张表回家。
    let open = null                                                                     // 正在累积的模型响应；遇到工具结果或新的用户消息就收口。

    // --- 第一趟：拼回合，并登记每个回合欠下的工具调用 ---
    for (const message of history) {
        if (message.role === 'tool') { open = null; continue }                           // 工具结果自己不开回合，但它意味着上一轮响应已经说完了。

        if (message.role === 'assistant' && open) open.push(message)                     // 同一次响应拆成的多条 assistant（思考、文字、调用）属于同一个回合。
        else {
            open = message.role === 'assistant' ? [message] : null                       // user 和总结各自独占一个回合，不接纳后续消息。
            turns.push(open ?? [message])
        }

        for (const part of parts(message)) if (part.type === 'tool-call') caller.set(part.toolCallId, turns.at(-1)) // 登记本回合欠下的调用。
    }

    // --- 第二趟：工具结果按 id 回到发起它的回合，跟它排在谁后面完全无关 ---
    for (const message of history) {
        if (message.role !== 'tool') continue
        caller.get(parts(message)[0]?.toolCallId)?.push(message)                         // 找不到发起者的结果不构成任何回合，自然消失。
    }

    return turns
}

// History 只比 AI SDK 多了 id、compact 这些顶层内部字段，去掉它们后直接交给模型。
// 这里同时摘掉两种不该出现在请求里的内容块：
// 思考内容留在 history 里供上层 UI 渲染，但不回传——它是某一次响应的厂商产物，不是持久对话状态，
//   回传会被不少服务直接拒绝（实测 gpt-oss-120b 返回 property 'reasoning_content' is unsupported），
//   而且这个包允许中途换模型，A 家的思考对 B 家本来也没有意义。
// 没人应答的工具调用也摘掉——history 是公开可写的，可能带着上次进程中断时留下的半截调用，
//   AI SDK 遇到它会在本地直接抛 MissingToolResultsError，请求根本发不出去，压缩也救不回来。
const forModel = (message, answered) => ({
    role: message.role,
    content: Array.isArray(message.content)
        ? message.content.filter(part => part.type !== 'reasoning' && (part.type !== 'tool-call' || answered.has(part.toolCallId)))
        : message.content,
})

const build = ({ history, system = '', tools = {} }) => {
    // --- 还原回合：从这里开始，历史只以回合为单位被处理 ---
    const turns = toTurns(history)

    // --- 定位最新总结：从后往前找，多次压缩后只有最后那一条算数 ---
    const summaryIndex = turns.findLastIndex(turn => turn[0].compact === true)
    let selected = turns                                                                                                            // 没有总结时，完整历史就是最准确的上下文。

    // --- 挑回合：最初目标 + 最新总结 + 总结前的最近现场 + 总结后的全部新回合 ---
    if (summaryIndex >= 0) {
        const before = turns.slice(0, summaryIndex)                                                                                 // 最新总结已经覆盖的范围，裁剪只在这里面挑。
        const covered = before.findLastIndex(turn => turn[0].compact === true)                                                      // 上一条总结：比它更老的原文已被总结过两次，不再回头捡。
        const goal = before.filter(turn => turn[0].role === 'user' && !turn[0].compact).slice(0, KEEP_FIRST)                         // 最初目标是用户自己说过的话，不拖着当时的工具现场一起钉在开头。
        const recent = before.slice(Math.max(covered + 1, summaryIndex - KEEP_BEFORE_SUMMARY)).filter(turn => !goal.includes(turn))  // 最近现场；已经进入最初目标的回合不重复出现。

        selected = [...goal, turns[summaryIndex], ...recent, ...turns.slice(summaryIndex + 1)]                                       // 顺序固定：总结作背景，现场作细节，新回合接在最后。
    }

    // --- 出口：回合只是 Context 内部的形状，交给模型的仍然是平铺消息 ---
    const flat = selected.flat()                                                                                                    // 回合内部保持原始顺序，展平后就是一段时间上连续的消息。
    const answered = new Set(flat.flatMap(message => parts(message).filter(part => part.type === 'tool-result').map(part => part.toolCallId))) // 这批消息里真正拿到结果的调用。

    const messages = [
        ...(system ? [{ role: 'system', content: system }] : []),                                                                   // system 进入 messages，并一起参与 Token 估算。
        ...flat.map(message => forModel(message, answered)).filter(message => message.content.length),                              // 被摘空的消息（只剩思考、或只剩没人应答的调用）整条丢掉。
    ]

    // Token 只在真的有人读的时候才算：没设 maxTokens 时 Loop 压根不看它，
    // 而 countTokens 要把整段上下文重新分词一遍（2000 条历史约 120ms），每轮都白烧一次。
    let counted
    return {
        messages,
        get token() {
            counted ??= countTokens(JSON.stringify({ messages, tools })) // 工具定义不属于 messages，但模型请求仍会携带它们，所以估算时一并计算。
            return counted
        },
    }
}

export default { build }
