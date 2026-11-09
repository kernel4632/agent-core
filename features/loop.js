/*
目标被调用形式（绝对不可修改）：
const result = await Loop.run({
    // --- 宿主的活对象（每轮请求前现读，不缓存）---
    // Loop 每一轮都把 agent.config 和 agent.tools 重新读一遍，再拼这一笔请求：
    // 宿主运行中改模型 / 思考强度 / system / 限额，或者把 agent.tools 换成另一份集合，
    // 下一笔请求就用新值，不用停掉当前任务，也不用重建 Agent。
    agent: {
        // config 的字段含义见 README 的「config 字段」；这里只列 Loop 会用到的那几项。
        config: {
            baseURL: "https://中转站/v1", apiKey: "sk-xxx", model: "model-name", protocol: "chat",
            provider: { temperature: 0.3, headers: {}, body: {} }, // AI SDK 生成参数
            system: "你是编程助手",      // 系统提示词
            capabilities: { tools: true, image: true, reasoning: false }, // 能力开关
            maxContextTokens: 128000,   // 上下文预算；设 Infinity 关闭自动压缩
            compactThreshold: 0.8,      // 达到预算的这个比例时压缩
            stream: true,               // 主请求和压缩都流式输出
            noToolPrompt: "请继续使用工具", // 有工具却连续不调时的提醒（只挂在那次请求上）
            noToolRounds: 3,            // 连续多少轮不调工具就好结束；Infinity 表示永不因此结束
            retryBaseDelay: 5000,       // 第一次退避基数（毫秒），之后 ×2
            retryMaxDelay: 600000,      // 重试退避上限（毫秒）
        },
        tools: { schema: {} },          // 当前的工具集合（Tool.from / scan / adopt 的返回值），只读不扫描
    },

    // --- 数据 ---
    history: [],                        // 完整历史消息列表；只有这一个数组，循环只往里追加，不换目标

    // --- 功能模块（必填，平齐的功能模块作为参数传）---
    buildContext: Context.build,       // 上下文构建模块
    compact: Compact.run,             // 上下文压缩模块
    executeTool: request => Tool.execute({ ...request, handlers: agent.tools.handlers }), // 工具执行模块，handlers 由调用方补上
    sessionId: "session-1",               // 压缩和工具输出使用的会话

    // --- 控制（可选）---
    signal: abortSignal,           // 取消信号

    // --- 回调（全部可选）---
    onStart: () => { },                    // 循环开始
    onLLMStart: (request) => { },          // 每次实际请求模型前
    onLLMFinish: (result) => { },          // 本次模型请求完成，返回完整 result
    onLLMEvent: event => {},               // 原样接收 AI SDK 的所有流事件
    onRetry: (info) => { },                // 请求失败重试中
    onPermission: async (permission) => { }, // 工具权限询问；必须严格返回 true 才放行，其它任何值都按拒绝
    onInject: async ({ tokens, budget, compactThreshold }) => '', // 每轮请求前问一次：返回字符串就临时附在本次请求末尾（不写进 history）
    onToolCall: (call) => { },              // 工具调用开始
    onToolOutput: (output) => { },          // 工具实时输出
    onToolResult: (result) => { },         // 工具执行完
    onStep: (step) => { },                 // 一轮模型和工具都完成后
    onCompact: (event) => { },             // 压缩过程通知
 })
 // result = { reason: 'finished' | 'no-tool' | 'tool-stop', text: '最后一轮模型生成的文字', steps: 模型轮数, usage: { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens } }
 */

import History from './history.js'
import LLM, { buildLLM } from './llm.js'
import TextTools from './text-tools.js'
import Notify from '../utils/notify.js'
import Retry from '../utils/retry.js'                                          // 复用它的重试过滤判据，auto 降级用同一份。
import isContextWindowError from '../utils/context-error.js' // 上下文超长的判据，Retry 用同一份。
import { createMeter, modelKey } from '../utils/tokens.js'

// 上下文超长时最多"压缩后重发"几次（照抄 Roo Code 的 MAX_CONTEXT_WINDOW_RETRIES）。
const CONTEXT_WINDOW_RETRIES = 3

const aborted = () => Object.assign(new DOMException('Agent loop aborted', 'AbortError'), { kind: 'aborted' }) // 取消错误也带 kind，调用方能和模型错误一样按 error.kind 分支。

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


// --- 问一次模型：工具走哪条路由 toolMode 决定 ---
//   native（默认）：工具描述放在接口的 tools 字段里，system 一个字都不多。
//   text：纯对话模型。工具说明写进 system，历史里的工具记录改写成文字，调用从回复文字里读回。
//   auto：先试原生；接口拒收工具字段就记住这个模型、改用文字协议重发。原生模型把调用写成了文字，也读回来。
const ask = async (request, llm) => {
    const { tools, messages } = request
    const textual = Object.keys(tools).length && (llm.toolMode === 'text' || (llm.toolMode === 'auto' && TextTools.remembered(llm)))
    const spec = Object.keys(tools).length && llm.toolMode !== 'native' ? await TextTools.prepare(tools) : null // 只有可能用到文字协议时才写说明书。

    // 文字协议：说明书和改写都在出门前做好，接口上不带 tools 字段。
    const byText = async () => TextTools.read(await LLM.chat({ ...request, messages: TextTools.wrap(messages, spec), tools: undefined }), spec, { loose: true })

    if (textual) return byText()

    // auto 模式要能在"接口拒收工具字段"时降级成文字协议。但默认是"除取消和上下文超长外全重试"，
    // 那个 400 会被一直重试、永远轮不到下面的 catch。所以把"工具被拒"并进调用方的重试过滤：
    // 命中就立刻抛出，交给 catch 改用文字协议；user 自己的过滤也一起保留。
    const native = llm.toolMode === 'auto' && spec
        ? { ...request, retry: error => !TextTools.refused(error) && !Retry.declines(llm.retry, error) }
        : request
    try {
        const result = await LLM.chat(native)
        return spec ? TextTools.read(result, spec) : result // auto 下原生没给调用时，模型可能把调用写成了文字。
    } catch (error) {
        if (llm.toolMode !== 'auto' || !spec || request.signal?.aborted || !TextTools.refused(error)) throw error
        const result = await byText()
        TextTools.remember(llm) // 文字协议真的跑通了才记住；上下文超长这类和工具无关的 400，换协议也会失败，不能把模型永久降级。
        return result
    }
}

const run = async ({
    agent, history, buildContext, compact, executeTool, sessionId, signal, meter = createMeter(),                                    // 宿主活对象、数据、功能模块、取消信号、token 估算器
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

        // --- 每轮现读一次宿主状态，现拼这一笔请求 ---
        // agent 是活对象：宿主在运行中改 agent.config、换 agent.tools，下一笔请求就用新值。
        // 已经发出去的那一笔和它发起的工具照常跑完，切换只发生在请求边界，流式过程中不热替换。
        // 工具表只读宿主手上那份，不重新扫描目录——扫描是宿主的事（Tool.from / scan）。
        // key 也跟着重算：换模型后 token 估算按新模型的比例记，不会拿旧模型的比例量新模型。
        const llm = buildLLM(agent.config)                                                // 模型、生成参数、能力开关、限额、重试都在里面。
        const system = agent.config.system                                                // 系统提示词。
        const tools = agent.config.capabilities.tools === false ? {} : agent.tools.schema // 这一轮给模型看的工具表。
        const key = modelKey(llm)

        // --- 构建上下文，Token 超限时压一次 ---
        // 每轮最多压一次，不循环压到达标为止：压缩本身就是一次真实模型请求，
        // 而"压完还是超限"通常意味着剩下的内容（单个巨大回合、或工具定义本身）根本压不动，
        // 循环只会一轮一轮地烧钱——实测 maxContextTokens 配小时能烧到 5500 次请求，
        // 每轮降一点点的情况下加了"没变小就停"的护栏也还能烧 122 次。
        // 压一次之后仍然超限就照常发出去，由模型服务判断收不收；下一轮如果还超，自然会再压一次。
        let context = buildContext({ history, system, tools, budget: llm.maxContextTokens, ratio: meter.ratio(key) })
        if (Number.isFinite(llm.maxContextTokens) && context.token >= llm.maxContextTokens * llm.compactThreshold) {
            // trigger 让 compact-start 能回答"为什么压、估算多少"——排查"上下文才 35% 就压了"这类问题时，
            // token / budget / compactThreshold / ratio 四个数缺一不可。
            const trigger = { reason: 'automatic', token: context.token, budget: llm.maxContextTokens, compactThreshold: llm.compactThreshold, ratio: meter.ratio(key) }
            const summary = await compact({ messages: context.messages, llm, stream: llm.stream, onCompact, onRetry, signal, trigger }) // 自动压缩只在接近上限时触发；Compact 本身不判断上下文大小。
            add(usage, summary.usage)                                         // 压缩也是一次真实模型请求，token 计进整次 send 的合计。
            history.push(History.compact({ content: summary.content }))        // 总结写回 history。
            context = buildContext({ history, system, tools, budget: llm.maxContextTokens, ratio: meter.ratio(key) })                // 用压缩后的历史重建上下文。
        }
        // 压缩只往 history 里追加一条总结，永远不删任何东西：
        // history 是这个项目唯一的权威数据来源，该保留多少由持有它的上层决定，核心包无权替它丢数据。
        // 压缩控制的是"这一轮发给模型的内容有多大"，不是"历史能留多少"。

        // --- 宿主想临时插一句吗：每轮请求前问一次，放在压缩之后，拿到的才是这一轮真正要用的估算 ---
        // 典型用法：上下文快到压缩点了，提醒模型这一轮收口。这句只挂在这一笔请求上，不写进 history。
        const injected = onInject ? await askInject(onInject, { tokens: context.token, budget: llm.maxContextTokens, compactThreshold: llm.compactThreshold }) : ''

        // --- 请求模型 ---
        // 重试不在这里：它是 LLM.chat 自带的，压缩那次请求走的是同一条路、同一套退避。
        if (signal?.aborted) throw aborted()
        // 上下文超长专项（照抄 Roo Code）：模型说"窗口放不下"时，先强制压缩一次再把这一笔请求重发，
        // 最多重试 CONTEXT_WINDOW_RETRIES 次；超过就按普通错误抛出。这是每轮自动压缩之外的兜底。
        // 临时提示（核心自己的 noToolPrompt + 宿主注入的）合在一条消息里，只挂在本次请求上。
        const buildRequest = () => {
            const prompt = [temporaryPrompt, injected].filter(Boolean).join('\n\n')
            return { ...llm, messages: prompt ? [...context.messages, History.user({ content: prompt })] : context.messages, tools, signal, onLLMEvent, onLLMStart, onRetry }
        }
        let result
        let sent
        for (let attempt = 0; ; attempt += 1) {
            try {
                sent = buildRequest()                        // 每次重发都用最新重建的 messages。
                result = await ask(sent, llm)
                break
            } catch (error) {
                if (attempt >= CONTEXT_WINDOW_RETRIES || !isContextWindowError(error)) throw error // 不是上下文超长，或已经压过 3 次，交给上层。
                const trigger = { reason: 'overflow-retry', token: context.token, budget: llm.maxContextTokens, compactThreshold: llm.compactThreshold, ratio: meter.ratio(key) } // 模型说窗口装不下，强制压一次再重发。
                const summary = await compact({ messages: context.messages, llm, stream: llm.stream, onCompact, onRetry, signal, trigger }) // 强制压缩一次。
                add(usage, summary.usage)                                     // 超长重压同样计费用量。
                history.push(History.compact({ content: summary.content }))   // 总结写回 history（只增不删）。
                context = buildContext({ history, system, tools, budget: llm.maxContextTokens, ratio: meter.ratio(key) }) // 用压缩后的历史重建上下文。
            }
        }
        steps += 1            // 模型完整回答后才算这一轮，失败重试由 LLM.chat 自己处理。
        add(usage, result.usage)
        meter.observe(key, { messages: sent.messages, tools }, result.usage?.inputTokens) // 用这个模型刚回的真实输入 token 数校准"每字符 token 比"，越用越准。
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

            const allowed = await checkPermission(onPermission, { sessionId, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input, signal }, signal) // 没权限回调时按无人值守模式直接放行；有回调时严格 true 才放行，取消不吊死。
            // 等待期间被取消：也按"已取消"结算，别写成"用户拒绝"——拒绝和取消是两回事，历史只增不删，写错了会永远留着。
            if (signal?.aborted) return denied({ type: 'error-text', value: '工具执行已取消' }, { stop: true })
            if (!allowed) return denied({ type: 'execution-denied', reason: '工具执行被用户拒绝' }) // 拒绝也是一条结果，模型需要知道。

            let value
            try {
                // onToolOutput 是高频流式回调，这里不等它：等一下就等于给模型输出加了一道节流阀。
                value = await executeTool({ name: call.toolName, input: call.input, toolCallId: call.toolCallId, signal, onOutput: output => onToolOutput?.({ ...output, ...call }) }) // Loop 只说要执行哪个工具，怎么找到它由调用方负责。
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

export default { run }
