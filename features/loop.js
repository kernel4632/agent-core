/*
主循环：反复「请求模型 → 执行工具」，直到模型不再要工具、工具要求停止，或连续 noToolRounds 轮不调工具。

调用：
    const result = await Loop.run({
        agent,                // 宿主的活对象：每一笔请求前现读 config / system / tools
        history,              // 完整历史；只追加，不换目标
        meter,                // token 估算器（可选，默认新建）
        signal,               // 取消信号（可选）
        ...callbacks,         // onStart / onLLMStart / onToolCall / onStep ...
    })
    const { content, usage } = await Loop.compact({ agent, history, meter, reason: 'manual', signal })

    result = { reason: 'finished' | 'no-tool' | 'tool-stop', text, steps, usage }
    content = 压缩出的总结文本；usage = 这一笔压缩请求的用量

每一笔请求（包括重试）前都用 agent 此刻的状态重新拼：模型、system、工具表、messages。
轮次只做有副作用的决定：要不要压缩、要不要注入提醒、连续几轮没调工具。
*/

import Context from './context.js'
import Compact from './compact.js'
import History from './history.js'
import Tool from './tool.js'
import LLM, { buildLLM } from './llm.js'
import TextTools from './text-tools.js'
import Notify from '../utils/notify.js'
import Retry from '../utils/retry.js'                                          // 复用它的重试过滤判据，auto 降级用同一份。
import isContextWindowError from '../utils/context-error.js' // 上下文超长的判据，Retry 用同一份。
import aborted from '../utils/abort.js'                        // 取消错误统一从这里造。
import { createMeter, modelKey } from '../utils/tokens.js'

// 上下文超长时最多"压缩后重发"几次（照抄 Roo Code 的 MAX_CONTEXT_WINDOW_RETRIES）。
const CONTEXT_WINDOW_RETRIES = 3

// 等权限回调，但取消信号一到就不再等它。onPermission 是用户代码，可能永远不返回，
// 不让它把 stop() 吊死（内存工具那边也是同样的"不等了"做法）。
const waitForPermission = async (asked, signal) => {
    if (!signal) return asked
    if (signal.aborted) return false // 进来时就已经取消：直接按拒绝，别去挂一个永远不触发的监听把自己吊死。
    let onAbort
    const stopped = new Promise(resolve => { onAbort = () => resolve(false); signal.addEventListener('abort', onAbort, { once: true }) })
    try { return await Promise.race([asked, stopped]) } finally { signal.removeEventListener('abort', onAbort) }
}

// 权限必须严格返回 true 才放行：其它任何值（含对象、漏 return 的 undefined）一律拒绝。
// 漏 return 多半是回调写错了，提醒一次就够，别每个工具调用都刷屏。
let warnedPermission = false
const checkPermission = async (onPermission, payload, signal) => {
    if (!onPermission) return true // 没回调＝无人值守，直接放行。（取消路径由 signal 在下面兜住。）
    const answer = await waitForPermission(onPermission(payload), signal)
    if (typeof answer !== 'boolean') {
        if (!warnedPermission) { warnedPermission = true; console.warn('onPermission 必须返回布尔值，非 true 一律按拒绝处理。') }
        return false
    }
    return answer
}

// --- 问宿主这一轮有没有要临时插一句的 ---
// 和 onPermission 一样，它的返回值要拿来用，所以不能走 Notify.tell（那里把返回值丢掉）。
// 但两者不同：权限决定"放不放行"，出错必须让调用方知道；而这里只是"加一句话"，
// 宿主的钩子坏了就当这一轮不注入，不打断正在跑的任务。
// 每轮都会问；"这次 run 只提醒一次"这种去重是宿主自己的业务策略，核心不替它记。
const askInject = async (onInject, info) => {
    if (!onInject) return ''
    try {
        const text = await onInject(info)
        return typeof text === 'string' ? text.trim() : ''
    } catch {
        return ''
    }
}

// --- 把一次请求的用量加进合计 ---
// 各供应商给的字段不一定齐全（有的不报缓存，有的连 total 都没有），缺的按 0 算，不让一个 undefined 把合计变成 NaN。
const add = (total, usage = {}) => {
    const details = usage.inputTokenDetails ?? {}
    total.inputTokens += usage.inputTokens ?? 0
    total.outputTokens += usage.outputTokens ?? 0
    total.totalTokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    total.cacheReadTokens += details.cacheReadTokens ?? usage.cachedInputTokens ?? 0
    total.cacheWriteTokens += details.cacheWriteTokens ?? 0
}


// --- 用 agent 此刻的状态建一份上下文 ---
// run 和 compact 都走这里；agent 的哪个字段对应 Context 的哪个参数，只在这一处翻译。
// 同时把这一份工具表一起拿出来：上下文和工具表必须来自同一刻的 agent 状态。
const build = (agent, history, ratio) => {
    const tools = agent.config.capabilities.tools === false ? {} : agent.tools.schema
    return {
        tools,
        context: Context.build({
            history,
            system: agent.config.system,
            tools,
            budget: agent.config.maxContextTokens,
            ratio,
            capabilities: agent.config.capabilities,
            mediaFallback: agent.config.mediaFallback,
            keep: agent.config.contextKeep,
        }),
    }
}


// --- 压一次历史：手动压缩和循环里的自动压缩走同一条路 ---
// 只追加一条总结，永远不删历史。调用方已经建好 context 就传进来，省一次重建。
const compact = async ({ agent, history, meter, reason, context, signal, onCompact, onRetry }) => {
    const key = modelKey(agent.config)                                  // 估算比例按主模型记
    context ??= build(agent, history, meter.ratio(key)).context         // 循环里已经建过就直接用
    const llm = buildLLM(agent.config, agent.config.compact)            // 用哪套模型压，也在这里定
    const { content, usage } = await Compact.run({
        messages: context.messages,
        llm, stream: llm.stream,
        onCompact, onRetry, signal,
        detail: {                                                       // 诊断信息只在压缩这一处拼，字段不会和事件脱节
            reason,
            token: context.token, budget: llm.maxContextTokens, compactThreshold: llm.compactThreshold,
            ratio: meter.ratio(key), ratioSource: meter.source(key),
            chars: context.chars, media: context.media, calibrated: meter.calibrated(key),
        },
    })
    history.push(History.compact({ content }))                         // 总结写回历史，只增不删
    return { content, usage }
}


// --- 问一次模型：工具走哪条路由 toolMode 决定 ---
//   native（默认）：工具描述放在接口的 tools 字段里，system 一个字都不多。
//   text：纯对话模型。工具说明写进 system，历史里的工具记录改写成文字，调用从回复文字里读回。
//   auto：先试原生；接口拒收工具字段就记住这个模型、改用文字协议重发。原生模型把调用写成了文字，也读回来。
//
// request 是"现拼这一笔请求"的函数：重试前才调，拿的是宿主此刻的状态。
// 第一笔用 ask 一开始拼的那份，不白拼两次。返回 { result, request }，Loop 用 request 做 token 校准。
// 协议模式（textual / auto 的降级）在每轮开始时定下，重试不会中途换协议。
const ask = async ({ request, llm, signal, onLLMEvent, onLLMStart, onRetry }) => {
    const first = request()                        // 第一笔请求：直接用它。
    const tools = first.tools
    const hasTools = Boolean(tools && Object.keys(tools).length)
    const textual = hasTools && (llm.toolMode === 'text' || (llm.toolMode === 'auto' && TextTools.remembered(llm)))
    const spec = hasTools && llm.toolMode !== 'native' ? await TextTools.prepare(tools) : null // 只有可能用到文字协议时才写说明书。

    // 文字协议：第一笔和重试都用最新的 messages / tools 重写一遍说明书，接口上不带 tools 字段。
    const byText = async () => {
        let used = await TextTools.prepare(first.tools)                                          // 这一笔的说明书
        let sent = { ...first, messages: TextTools.wrap(first.messages, used), tools: undefined } // 说明书并进 system，工具记录改写成文字。
        const refresh = async () => {
            const next = request()
            used = await TextTools.prepare(next.tools)                                           // 工具表可能在重试期间变了，说明书跟着重写。
            return (sent = { ...next, messages: TextTools.wrap(next.messages, used), tools: undefined })
        }
        const result = await LLM.chat({ ...llm, ...sent, signal, onLLMEvent, onLLMStart, onRetry, refresh })
        return { result: TextTools.read(result, used, { loose: true }), request: sent }           // 从回复文字里读回工具调用。
    }

    if (textual) return byText()

    // auto 模式要能在"接口拒收工具字段"时降级成文字协议。但默认是"除取消和上下文超长外全重试"，
    // 那个 400 会被一直重试、永远轮不到下面的 catch。所以把"工具被拒"并进调用方的重试过滤：
    // 命中就立刻抛出，交给 catch 改用文字协议；user 自己的过滤也一起保留。
    const autoRetry = llm.toolMode === 'auto' && spec
        ? { retry: error => !TextTools.refused(error) && !Retry.declines(llm.retry, error) }
        : {}
    let sent = first
    const refresh = () => (sent = request())       // 重试前现拼：退避期间宿主改了配置，下一笔就用新的。
    try {
        const result = await LLM.chat({ ...llm, ...first, signal, onLLMEvent, onLLMStart, onRetry, ...autoRetry, refresh })
        return { result: spec ? TextTools.read(result, spec) : result, request: sent } // auto 下原生没给调用时，模型可能把调用写成了文字。
    } catch (error) {
        if (llm.toolMode !== 'auto' || !spec || signal?.aborted || !TextTools.refused(error)) throw error
        const done = await byText()
        TextTools.remember(llm) // 文字协议真的跑通了才记住；上下文超长这类和工具无关的 400，换协议也会失败，不能把模型永久降级。
        return done
    }
}

const run = async ({
    agent, history, signal, meter = createMeter(),                                    // 宿主活对象、数据、取消信号、token 估算器
    onStart, onLLMStart, onLLMFinish, onPermission, onLLMEvent, onRetry, onInject, onToolCall, onToolOutput, onToolResult, onStep, onCompact, // 全部回调，没传的自动跳过
}) => {
    await Notify.tell(onStart) // 外部需要时知道循环已经开始了。
    let noToolCount = 0        // 记录连续没有工具调用的模型回合。
    let steps = 0              // 一次 send 发给模型的轮数；重试属于同一轮，压缩不算任务轮次。
    let temporaryPrompt = null  // 工具提示只临时发送给模型，不写入 history。
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } // 整次 send 的用量合计；算钱、看缓存命中都从这里读，不用自己在回调里累加。

    while (true) {
        // --- 每轮开始：先响应取消信号 ---
        if (signal?.aborted) throw aborted()

        // --- 这一轮先用一份快照做决策：压缩、注入、轮次计数 ---
        // 真正发请求时还会再拼一次（见下面 request），所以这里快照旧了也不会写进请求；
        // 它只用于"这一轮要不要压缩、要不要提醒"这类有副作用的决定。
        // agent 是活对象：宿主运行中改 agent.config、换 agent.tools，下一笔请求就用新值。
        // 已经发出去的那一笔和它发起的工具照常跑完，切换只发生在请求边界，流式过程中不热替换。
        // 工具表只读宿主手上那份，不重新扫描目录——扫描是宿主的事（Tool.from / scan）。
        // key 也跟着重算：换模型后 token 估算按新模型的比例记，不会拿旧模型的比例量新模型。
        meter.seed(agent.config.contextRatio)                                          // 宿主可能运行中改了冷启动倍率；学到的真实值仍然优先于它。
        const llm = buildLLM(agent.config)                                                // 模型、生成参数、能力开关、限额、重试都在里面。
        const key = modelKey(llm)

        // --- 构建上下文，Token 超限时压一次 ---
        // 每轮最多压一次，不循环压到达标为止：压缩本身就是一次真实模型请求，
        // 而"压完还是超限"通常意味着剩下的内容（单个巨大回合、或工具定义本身）根本压不动，
        // 循环只会一轮一轮地烧钱——实测 maxContextTokens 配小时能烧到 5500 次请求，
        // 每轮降一点点的情况下加了"没变小就停"的护栏也还能烧 122 次。
        // 压一次之后仍然超限就照常发出去，由模型服务判断收不收；下一轮如果还超，自然会再压一次。
        let { context, tools } = build(agent, history, meter.ratio(key))                 // 这一轮的上下文和工具表来自同一刻的 agent 状态。
        if (Number.isFinite(llm.maxContextTokens) && context.token >= llm.maxContextTokens * llm.compactThreshold) {
            const summary = await compact({ agent, history, meter, reason: 'automatic', context, signal, onCompact, onRetry }) // 自动压缩只在接近上限时触发。
            add(usage, summary.usage)                                                    // 压缩也是一次真实模型请求，token 计进整次 send 的合计。
            ;({ context, tools } = build(agent, history, meter.ratio(key)))              // 用压缩后的历史重建上下文。
        }
        // 压缩只往 history 里追加一条总结，永远不删任何东西：
        // history 是这个项目唯一的权威数据来源，该保留多少由持有它的上层决定，核心包无权替它丢数据。
        // 压缩控制的是"这一轮发给模型的内容有多大"，不是"历史能留多少"。

        // --- 宿主想临时插一句吗：每轮请求前问一次，放在压缩之后，拿到的才是这一轮真正要用的估算 ---
        // 典型用法：上下文快到压缩点了，提醒模型这一轮收口。这句只挂在这一笔请求上，不写进 history。
        const injected = onInject ? await askInject(onInject, { tokens: context.token, budget: llm.maxContextTokens, compactThreshold: llm.compactThreshold, ratio: meter.ratio(key), ratioSource: meter.source(key) }) : ''

        // --- 请求模型 ---
        // 重试不在这里：它是 LLM.chat 自带的，压缩那次请求走的是同一条路、同一套退避。
        if (signal?.aborted) throw aborted()

        // --- 每一笔请求前现拼一次：连接、system、工具表、messages 都读宿主此刻的状态 ---
        // 重试是新的请求。退避期间宿主完全可能把 model / provider / system / tools 换掉，
        // 下一笔就必须用新值——否则切了模型却一直卡在旧模型上重试（issue #29）。
        // 只重拼请求内容，不重做轮次级的决定（压缩、注入、轮次计数）：那些有副作用，属于"这一轮怎么决策"。
        // 已经发出去、正在流式的那一笔不打断；它由 LLM.chat 负责。
        let sent = null   // 最近一笔真正发出去的请求：token 校准要用它（重试可能已经换了模型）。
        const request = () => {
            meter.seed(agent.config.contextRatio)                                                       // 宿主的冷启动倍率也可能在重试期间被改。
            const current = buildLLM(agent.config)                                                     // 连接、生成参数、能力开关、限额，全是此刻的值。
            const built = build(agent, history, meter.ratio(modelKey(current)))                         // messages 和工具表一起现推。
            const prompt = [temporaryPrompt, injected].filter(Boolean).join('\n\n')                     // 核心的提醒 + 宿主注入的那句。
            const messages = prompt ? [...built.context.messages, History.user({ content: prompt })] : built.context.messages
            return { ...current, messages, tools: built.tools }
        }

        // 上下文超长专项（照抄 Roo Code）：模型说"窗口放不下"时，先强制压缩一次再把这一笔请求重发，
        // 最多重试 CONTEXT_WINDOW_RETRIES 次；超过就按普通错误抛出。这是每轮自动压缩之外的兜底。
        let result
        for (let attempt = 0; ; attempt += 1) {
            try {
                const answer = await ask({ request, llm, signal, onLLMEvent, onLLMStart, onRetry })
                result = answer.result
                sent = answer.request                       // 真正发出去的那一份，校准和日志都以它为准。
                break
            } catch (error) {
                if (attempt >= CONTEXT_WINDOW_RETRIES || !isContextWindowError(error)) throw error // 不是上下文超长，或已经压过 3 次，交给上层。
                const summary = await compact({ agent, history, meter, reason: 'overflow-retry', context, signal, onCompact, onRetry }) // 模型说窗口装不下，强制压一次再重发。
                add(usage, summary.usage)                                     // 超长重压同样计费用量。
                ;({ context, tools } = build(agent, history, meter.ratio(key))) // 用压缩后的历史重建上下文。
            }
        }
        steps += 1            // 模型完整回答后才算这一轮，失败重试由 LLM.chat 自己处理。
        add(usage, result.usage)
        meter.observe(modelKey(sent), { messages: sent.messages, tools: sent.tools }, result.usage?.inputTokens) // 用真正发出去那一笔的真实用量校准，越用越准。
        await Notify.tell(onLLMFinish, result) // 上层拿到完整 result，自行选择 usage 或其他字段。
        const answer = { text: result.text, ...('output' in result ? { output: result.output } : {}), steps, usage: { ...usage } } // 最终对象和文字来自同一轮，不能从旧历史猜结果。用量是到这一轮为止的合计。
        temporaryPrompt = null      // 提示已经用过，下一轮默认不再携带。

        // --- 处理无工具调用的情况 ---
        const toolCalls = result.toolCalls || []                                                        // 模型这轮想调用的工具。
        const assistantMessages = result.responseMessages.filter(message => message.role === 'assistant').map(History.stored) // 只保留 assistant 消息；补上 id 再进 history，前端才能定位每一条。

        if (!toolCalls.length) {
            history.push(...assistantMessages)                                  // 保存模型完整 assistant 消息。
            await Notify.tell(onStep, { step: steps, result, toolCalls, toolResults: [] }) // 让调用方在回答已经写入 history 后观察这一轮。
            if ('output' in result || !Object.keys(tools).length) return { reason: 'finished', ...answer } // 结构化输出已校验成功，或根本没注册工具：这就是最终回答，不再追问。
            noToolCount += 1                                                    // 累计没有工具调用的轮次。
            if (noToolCount === llm.noToolRounds - 1) temporaryPrompt = llm.noToolPrompt // 结束前一轮：插入临时提示推一下模型。
            if (noToolCount >= llm.noToolRounds) return { reason: 'no-tool', ...answer } // 到达上限：返回最后一次回答。Infinity 时这里永不触发。
            continue
        }
        noToolCount = 0 // 有工具调用，计数清零。

        // --- 并行执行所有工具调用 ---
        // Promise.all 让所有工具同时开跑，返回结果的顺序和 toolCalls 一致。
        // 流式输出通过 onToolOutput 带上 toolCallId 实时发出，上层靠 ID 区分是哪个工具的输出。
        const toolResults = await Promise.all(toolCalls.map(async call => {
            await Notify.tell(onToolCall, call) // 让上层知道即将执行哪个工具。

            // 这些路径同样"已经结算、结果即将写进 history"，和正常执行一样属于一次完整的工具调用；
            // 只通知 onToolCall 不通知 onToolResult，会让按结果回调更新界面/落盘的应用永远停在"运行中"。
            const settled = output => ({ call, output })
            const denied = (output, extra = {}) => {
                void Notify.tell(onToolResult, { ...call, ...extra, output }) // 拒绝/取消/无效也要让上层知道这次调用结束了。
                return { call, output, ...extra }
            }

            // AI SDK 标记 invalid 的调用：参数没法解析，或模型点了一个不存在的工具。
            // 此时 call.input 是原始字符串而不是对象，真跑下去等于拿脏数据喂工具。告诉模型让它重来。
            if (call.invalid) return denied({ type: 'error-text', value: `工具调用无效：${call.error?.message ?? '参数无法解析，或这个工具不存在'}` })

            // 模型已经产生了完整工具调用。即使此刻被取消，也要给它补一条取消结果。
            if (signal?.aborted) return denied({ type: 'error-text', value: '工具执行已取消' }, { stop: true })

            const allowed = await checkPermission(onPermission, { sessionId: agent.id, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input, signal }, signal) // 没权限回调时按无人值守模式直接放行；有回调时严格 true 才放行，取消不吊死。
            // 等待期间被取消：也按"已取消"结算，别写成"用户拒绝"——拒绝和取消是两回事，历史只增不删，写错了会永远留着。
            if (signal?.aborted) return denied({ type: 'error-text', value: '工具执行已取消' }, { stop: true })
            if (!allowed) return denied({ type: 'execution-denied', reason: '工具执行被用户拒绝' }) // 拒绝也是一条结果，模型需要知道。

            let value
            try {
                // onToolOutput 是高频流式回调，这里不等它：等一下就等于给模型输出加了一道节流阀。
                value = await Tool.execute({ name: call.toolName, input: call.input, toolCallId: call.toolCallId, handlers: agent.tools.handlers, limit: agent.config.maxToolOutput, signal, onOutput: output => onToolOutput?.({ ...output, ...call }) }) // 执行时现读 handlers 和输出上限，和发请求用的是同一刻的 agent 状态。
            } catch (error) {
                // 工具失败属于工具结果，不能让一次工具失败打断整个 Agent 循环。
                // 取消路径由 tool.js 用 resolve 处理，不会走到这里；这里接的是"工具名不在表里"这类调用错误。
                const output = { type: 'error-text', value: `工具执行失败：${error.message}` } // 失败信息也交给模型，让它自己决定怎么补救。
                await Notify.tell(onToolResult, { ...call, error: error.message, output })
                return { ...settled(output) } // settled 里的 call/output 形状和正常路径一致，onStep 拿到的才是完整结果。
            }
            await Notify.tell(onToolResult, { ...call, result: value, output: value.output })                   // 通知上层这个工具已经执行完。
            return { ...settled(value.output), stop: value?.stop === true || value?.interrupted === true }    // 工具主动停止或被中断都要结束循环。
        }))

        // --- 把本轮消息和工具结果写回历史 ---
        history.push(...assistantMessages) // AI SDK 的 tool 消息不用，工具结果由项目自己的执行器生成。
        for (const { call, output } of toolResults) history.push(History.tool({ toolCallId: call.toolCallId, toolName: call.toolName, content: output }))
        // onStep 带完整结果（call + output + stop/error），和 onToolResult 同一种形状：
        // 想在轮次结束时"这轮工具都返回了什么"直接读这里，不必再去监听 onToolResult 自己拼。
        await Notify.tell(onStep, { step: steps, result, toolCalls, toolResults })   // 工具结果已写入 history，调用方可安全持久化这一轮。

        // --- 判断是否停止循环 ---
        if (toolResults.some(result => result.stop)) {                                          // 任何一个工具要求停止，整个循环就结束。
            if (signal?.aborted) throw aborted()      // 取消导致的停止，仍然按异常向上抛。
            return { reason: 'tool-stop', ...answer } // 工具主动停止时不另外生成未请求的最终对象。
        }
    }
}

export default { run, compact }
