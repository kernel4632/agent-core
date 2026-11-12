/* 包入口：import Agent from '@kernel4632/agent-core'。所有能力都挂在 Agent 上，这个文件把各功能组合起来。

    const agent = Agent.create({
        config: { baseURL, apiKey, model, system: '你是一个助手。' },
        tools,                              // Agent.tool.from(...) 的返回值
        callbacks: { onToolResult: r => console.log(r.toolName, r.output) },
    })
    const answer = await agent.send('帮我做件事')
    console.log(answer.text, answer.reason)

完整的配置项、回调、返回值，以及工具来源（文件 / 内存 / MCP / 技能）见 README 的「API 参考」和「接入 MCP 和技能」。

一次运行的完整生命周期：
1. create 建出 Agent，把默认配置和工具归一化后存好；
2. send 有输入就把它推进只增不删的历史（没有输入就是"继续"），再交给 start 启动；
3. start 停掉上一次还在跑的运行，合入外部取消信号，然后执行本轮工作；
4. 工作里由 Loop 反复「请求模型 → 执行工具」，上下文接近预算时调 Compact 压缩；
   每一笔请求（包括同一轮里的每次重试）前都会重新取一次配置、system 和工具表，所以运行中改这些东西，下一笔请求就生效；
5. 运行结束（成功或失败）后清空 running，下一次 send 才能干净地开始。
*/

import { nanoid } from 'nanoid'
import { Output } from 'ai'                   // 输出格式直接复用本包的 AI SDK，不维护另一套 schema 协议。
import { z } from 'zod'                       // 调用方从 Agent.schema 获取格式定义，无需另装验证库。
import Context from './features/context.js'   // 负责把历史消息裁剪成模型上下文
import Compact from './features/compact.js'   // 负责把上下文压缩成总结文本
import Loop from './features/loop.js'         // 负责驱动"请求模型 → 执行工具"的主循环
import Tool from './features/tool.js'         // 负责扫描、接纳和执行工具
import LLM from './features/llm.js'           // 底层请求封装（对外只暴露 chat）
import TextTools from './features/text-tools.js' // 纯对话模型的文字工具协议，直接用 LLM.chat 时也能自己调
import History from './features/history.js'   // 负责创建标准格式的历史消息块
import { createMeter, modelKey } from './utils/tokens.js' // 本地 token 估算器：按模型记账，用真实 usage 自校准
import { badPart, PART } from './utils/shape.js' // 内容块形状校验：send 的用户输入也用它挡一下，别让坏块进只增不删的历史
import { version } from './package.json'      // 版本号只在 package.json 里写一次，打包时会被内联进产物


// --- 默认值只有这一处 ---
// 默认开启的能力。结构化输出、工具选择、用量统计都开；reasoning 默认关，
// 因为多数模型不返回思考内容，开着只会白占字段。mediaDefaults 来自 History，保证媒体格式统一。
const DEFAULT_CAPABILITIES = { ...History.mediaDefaults, tools: true, structuredOutput: true, toolChoice: true, reasoning: false, usage: true }
// 上下文用到预算的 80% 就触发压缩：留两成余量给压缩请求本身，避免刚要压就又超预算。
const DEFAULT_COMPACT_THRESHOLD = 0.8
// 默认上下文预算 128000。不显式设置也会在接近上限时自动压缩，避免把上下文撑爆；设 Infinity 可关掉自动压缩。
const DEFAULT_MAX_CONTEXT_TOKENS = 128000
// 连续 3 轮模型都没调用工具就插一条提醒，逼它重新走工具。次数太少会误伤纯聊天，太多则白烧轮次。
const DEFAULT_NO_TOOL_ROUNDS = 3
// 那条提醒的原文。特意写成“系统提醒、请勿对话回复”，防止模型把它当成用户的话接着闲聊。
const DEFAULT_NO_TOOL_PROMPT = '[错误] 你刚才的响应中没有使用工具！请继续使用工具（这是一条系统提醒消息，请勿以对话形式回复）'

// --- 入口检查：被入口直接调用的指令只在这里查一次 ---
// 返回第一条不合法的问题（一个带原因的 Error），全都合法就返回 null。
// 为什么放在最外层统一查：历史只增不删，一个坏值一旦写进去，以后每次 send 都会被 AI SDK 本地拒收，
// 等于把这个会话永久毒化。宁可在入口报一个带原因的错，也不放它进去。config / history / callbacks 同理。
const inputProblem = (input, limits) => {
    const positive = (value, finite = true) => value === undefined || (finite ? Number.isInteger(value) && value >= 1 : value === Infinity || Number.isInteger(value) && value >= 1)
    // input 省略表示"从当前历史接着跑"（见 send），只有真给了输入才校验它。
    if (input !== undefined) {
        const empty = typeof input === 'string' ? !input.trim() : !Array.isArray(input) || !input.length
        if (empty) return new TypeError('input must be a non-empty string or a non-empty content array')
        // 内容块数组也当边界查一次：形状坏的块写进只增不删的历史后，之后每次 send 都会被 AI SDK 本地拒收。
        if (Array.isArray(input)) {
            const bad = input.find(part => PART.has(part?.type) && badPart(part))
            if (bad) return new TypeError(`内容块的 ${JSON.stringify(bad.type)} 形状不合法：媒体要 mediaType 且值是字符串 / URL / 二进制`)
        }
    }
    // maxContextTokens 是上下文预算，允许 Infinity 表示关闭自动压缩；字符串 '1000' 会让压缩永远不触发。
    if (!positive(limits.maxContextTokens, false)) return new RangeError('maxContextTokens must be a positive integer or Infinity')
    // maxTokens 是单次生成的最大输出 token；不设（undefined）跳过，设了就必须是正整数。
    if (!positive(limits.maxTokens)) return new RangeError('maxTokens must be a positive integer')
    // noToolRounds 允许 Infinity，表示“永远提醒”。
    if (!positive(limits.noToolRounds, false)) return new RangeError('noToolRounds must be a positive integer or Infinity')
    if (!positive(limits.maxToolOutput, false)) return new RangeError('maxToolOutput must be a positive integer or Infinity') // 0/负数会把工具输出静默截成空。
    // 重试参数：退避基数和上限是毫秒数（允许 0，等于不等待）；总时长可设 Infinity。
    // 这里用"非负整数"而不是"正整数"，因为 0 是常用做法（测试和"不想等待"的场景），p-retry 也接受 0。
    const nonNegative = (value, finite = true) => value === undefined || (finite ? Number.isInteger(value) && value >= 0 : value === Infinity || Number.isInteger(value) && value >= 0)
    if (!nonNegative(limits.retryBaseDelay)) return new RangeError('retryBaseDelay must be a non-negative integer')
    if (!nonNegative(limits.retryMaxDelay, false)) return new RangeError('retryMaxDelay must be a non-negative integer or Infinity')
    if (!nonNegative(limits.retryMaxElapsed, false)) return new RangeError('retryMaxElapsed must be a non-negative integer or Infinity')
    // retryMaxTries 是"最多再重试几次"：0 表示不重试；缺省 / null / Infinity 表示不限。
    if (!(limits.retryMaxTries === undefined || limits.retryMaxTries === null || limits.retryMaxTries === Infinity || (Number.isInteger(limits.retryMaxTries) && limits.retryMaxTries >= 0))) return new RangeError('retryMaxTries must be a non-negative integer or Infinity')
    // retry 是调用方的过滤开关：函数，或 { skipCodes, skipText, skipKinds, shouldRetry } 对象。
    if (limits.retry !== undefined && typeof limits.retry !== 'function' && (typeof limits.retry !== 'object' || limits.retry === null || Array.isArray(limits.retry))) return new TypeError('retry must be a function or an object')
    // 阈值必须落在 (0, 1]：0 会每轮都压缩，大于 1 则永远触发不了。
    if (!(typeof limits.compactThreshold === 'number' && Number.isFinite(limits.compactThreshold) && limits.compactThreshold > 0 && limits.compactThreshold <= 1)) return new RangeError('compactThreshold must be a number in (0, 1]')
    // 冷启动的估算倍率：必须是正数，写错了整个上下文估算都会偏。
    if (limits.contextRatio !== undefined && !(typeof limits.contextRatio === 'number' && Number.isFinite(limits.contextRatio) && limits.contextRatio > 0)) return new RangeError('contextRatio must be a positive number')
    // 压缩保留策略：轮数是非负整数（0 = 这一段不留），占比落在 [0, 1]；写错了只会在压缩那一刻静默生效，
    // 所以在入口一次说清楚。不传就完全跳过，用默认值。
    const keep = limits.contextKeep
    if (keep !== undefined) {
        if (keep === null || typeof keep !== 'object' || Array.isArray(keep)) return new TypeError('contextKeep must be an object')
        for (const name of ['firstTurns', 'recentTurns']) if (keep[name] !== undefined && !(Number.isInteger(keep[name]) && keep[name] >= 0)) return new RangeError(`contextKeep.${name} must be a non-negative integer`)
        for (const name of ['firstShare', 'recentShare']) if (keep[name] !== undefined && !(typeof keep[name] === 'number' && Number.isFinite(keep[name]) && keep[name] >= 0 && keep[name] <= 1)) return new RangeError(`contextKeep.${name} must be a number in [0, 1]`)
    }
    if (!['native', 'text', 'auto'].includes(limits.toolMode)) return new TypeError("toolMode must be 'native', 'text' or 'auto'") // 拼错的 toolMode 会被默默当成 native。
    return null
}

// --- 一次 send 传入的 config 合并进 Agent 当前配置 ---
// provider 和 retry 整份替换（调用方给了就整份用它的，凭据和过滤规则不该和历史残留混在一起）；
// capabilities、compact 和 contextKeep 按字段叠加（它们是嵌套配置，只传其中一项不该把另一项丢掉）。其余字段覆盖。
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const mergeConfig = (current, override) => ({
    ...current,
    ...override,
    provider: 'provider' in override ? { ...override.provider } : current.provider,
    retry: 'retry' in override ? override.retry : current.retry,
    capabilities: 'capabilities' in override ? { ...current.capabilities, ...override.capabilities } : current.capabilities,
    compact: 'compact' in override ? { ...current.compact, ...override.compact } : current.compact,
    // 非对象原样留着交给入口校验：直接展开会把 'x' 变成 {0:'x'}，错误就被藏起来了。
    contextKeep: 'contextKeep' in override ? (plainObject(override.contextKeep) ? { ...current.contextKeep, ...override.contextKeep } : override.contextKeep) : current.contextKeep,
})


// --- 开始一次运行：先停掉上一次，再做这一次的事 ---
// running 只保留“最近一次”运行，取舍是：同一个 Agent 一次只干一件事。
// 新运行进来会先 abort 上一次并等它收尾，避免两条循环同时改同一份历史。
// 外部 signal 已经取消时直接拒绝，且不碰 running——不能因为一次注定失败的新调用，把还在跑的上一次挤出状态。
const start = (agent, work, outside) => {
    if (outside !== undefined && !(outside instanceof AbortSignal)) return Promise.reject(new TypeError('signal must be an AbortSignal'))
    // 调用方给的 signal 进来就已经取消：这次注定失败，直接拒绝——连 agent.running 都不碰，别把还在跑的上一次挤出状态。
    if (outside?.aborted) return Promise.reject(Object.assign(new DOMException('Agent run aborted', 'AbortError'), { kind: 'aborted' }))
    const previous = agent.running
    const controller = new AbortController()
    const signal = outside ? AbortSignal.any([controller.signal, outside]) : controller.signal

    const task = (async () => {
        if (previous) {
            previous.controller.abort()
            await previous.task.catch(() => {})
        }
        if (signal.aborted) throw Object.assign(new DOMException('Agent run aborted', 'AbortError'), { kind: 'aborted' }) // 取消也带 kind，和模型错误一致。
        return work(signal)
    })()

    // 运行结束时清空 running，但只清自己这一条：用 task 相等判断，防止清掉后来居上的新运行。
    agent.running = { controller, task }
    task.finally(() => {
        if (agent.running?.task === task) agent.running = null
    }).catch(() => {})
    return task
}


// 创建一台独立 Agent。
// tools 接受 scan()/adopt() 的返回值、数组、record 或 null，内部自动归一化。
const create = ({ id = nanoid(), history = [], config = {}, tools = null, callbacks = {} } = {}) => {
    // 边界检查：create 收到的坏值当场说清楚，别等到 send 才抛出难懂的错误（send 对这几个字段已有同样的检查）。
    if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('config must be an object')
    if (!Array.isArray(history)) throw new TypeError('history must be an array')
    if (callbacks === null || typeof callbacks !== 'object' || Array.isArray(callbacks)) throw new TypeError('callbacks must be an object')
    const meter = createMeter()   // 这台 Agent 的 token 估算器：按模型自校准，跨 send 复用。
    meter.seed(config.contextRatio) // 宿主持久化的冷启动倍率：没学到真实值之前先用它，重启后第一次估算就不会用默认 0.6。
    // 放闭包里、不挂到 agent 上，是因为它属于内部记账细节，暴露出去只会让公开状态更难预测。
    const agent = {
        id,
        history,
        config: {
            baseURL: '',
            apiKey: '',
            model: '',
            protocol: 'chat',
            provider: {},
            cache: true,
            mediaFallback: 'error',
            maxToolOutput: undefined,
            contextRatio: undefined,    // 冷启动估算倍率（每字符多少 token）；没学到真实 usage 之前用它。
            retryBaseDelay: 5000,       // 第一次退避基数（毫秒），之后 ×2；照抄 Roo Code 的 5 秒。
            retryMaxDelay: 600000,      // 单次退避上限（毫秒）；照抄 Roo Code 的 600 秒封顶。
            retryMaxElapsed: undefined, // 不限重试总时长（Roo 没有总上限）；可设毫秒数收口。
            retryMaxTries: undefined,   // 不限重试次数；0＝不重试，正整数＝最多再重试几次。
            retry: undefined,           // 调用方过滤不想重试的错误；不设＝默认全重试。
            requestTimeout: undefined,
            noToolPrompt: DEFAULT_NO_TOOL_PROMPT,
            compact: undefined,
            output: undefined,
            stream: true,
            toolMode: 'native',
            system: '',
            ...config,
            provider: { ...config.provider },
            capabilities: { ...DEFAULT_CAPABILITIES, ...config.capabilities },
            maxTokens: config.maxTokens, // 单次生成的最大输出 token；默认不设（undefined），会映射成请求体的 maxOutputTokens。
            maxContextTokens: config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS, // 上下文预算；默认开启自动压缩，想关掉设 maxContextTokens: Infinity。
            compactThreshold: config.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD,
            noToolRounds: config.noToolRounds ?? DEFAULT_NO_TOOL_ROUNDS,
        },
        // 工具在进公开状态前先过 Tool.adopt 归一化：数组、record、{ schema, handlers }、null 都被收成
        // 同一套形状，后面 send / compact 拿来直接用，不必每处再判断一次工具来源。
        tools: Tool.adopt(tools),
        callbacks: { ...callbacks },
        running: null,
    }

    // send：把一次用户输入推进历史并跑完整个循环，返回最终回答。
    // 两种写法：send('文本') / send({ input, config, tools, history, callbacks, signal })。
    // **不带输入就是"继续"**：直接把当前历史交给循环（末尾是 user 就回答它，是 assistant/tool 就接着说，
    // 空历史也行）。"继续"和"发新消息"是同一个动作的两种起始状态，不分成两个方法。
    // 边界上先查 config / history / callbacks 和 input 本身，坏值绝不写进 Agent 状态。
    agent.send = (input, options = {}) => {
        if (typeof input === 'object' && input !== null && !Array.isArray(input)) ({ input, ...options } = input) // send({ input, ... })：对象写法里没写 input 就是继续。

        const badConfig = 'config' in options && (typeof options.config !== 'object' || options.config === null || Array.isArray(options.config))
        const badHistory = 'history' in options && !Array.isArray(options.history) // 覆盖会写回 Agent，坏值必须先挡在门外，否则这台 Agent 之后每次 send 都崩。
        const badCallbacks = 'callbacks' in options && (typeof options.callbacks !== 'object' || options.callbacks === null || Array.isArray(options.callbacks))
        const limits = badConfig || !options.config ? agent.config : mergeConfig(agent.config, options.config) // 和真正生效的合并规则同一处，别在这里再写一遍浅合并。
        const invalid =
            badConfig ? new TypeError('config must be an object')
            : badHistory ? new TypeError('history must be an array')
            : badCallbacks ? new TypeError('callbacks must be an object')
            : inputProblem(input, limits)
        if (invalid) return Promise.reject(invalid)

        // 真正开始前才把 options 里的覆盖写回 Agent：前面所有校验都过了，这里才不会写进半成品状态。
        return start(agent, async signal => {
            if ('history' in options) agent.history = options.history
            if ('config' in options) agent.config = mergeConfig(agent.config, options.config)
            if ('tools' in options) agent.tools = await Tool.from(options.tools) // send 是异步的，传来的目录会现扫；create 是同步的，只收已经装好的工具。
            if ('callbacks' in options) agent.callbacks = { ...agent.callbacks, ...options.callbacks }
            const callbacks = { ...agent.callbacks }

            if (input !== undefined) agent.history.push(History.user({ content: input })) // 不带输入（继续）：不追加任何消息。

            return Loop.run({
                agent,                      // 活对象：Loop 每一笔请求前都从它现读 config、system 和工具表，宿主运行中改了就下一笔生效（重试也算）。
                history: agent.history,     // 数据固定这一个数组：循环只往里追加，不换目标。
                meter,                      // token 估算器：跨 send 复用，按模型记住自校准的比例。
                ...callbacks,
                signal,
            })
        }, options.signal)
    }


    // stop：取消当前正在跑的那次运行，并等它真正收尾后再回 { ok: true }。
    // 本来就没在跑就返回 { ok: false }，让调用方能区分“停掉了”和“当时没东西可停”。
    agent.stop = async () => {
        if (!agent.running) return { ok: false }
        const running = agent.running
        running.controller.abort()
        await running.task.catch(() => {})
        if (agent.running === running) agent.running = null
        return { ok: true }
    }


    // compact：手动跑一次上下文压缩，把结果作为一条 compact 消息追加进历史，并返回压缩出的文本。
    // 和 send 走同一个 start，所以同样会先停掉上一次运行，也接受外部取消信号。
    agent.compact = ({ onCompact = agent.callbacks.onCompact, onRetry = agent.callbacks.onRetry, ...options } = {}) => start(agent, async signal => {
        const { content } = await Loop.compact({
            agent, history: agent.history, meter,
            reason: 'manual',
            signal, onCompact, onRetry,
        })
        return content
    }, options.signal) // 手动压缩也接受外部取消信号，和 send 一致。


    // --- 估算倍率的持久化入口：宿主按自己（provider + model）存，core 不碰磁盘 ---
    // 读当前模型用的倍率，宿主可以存起来；calibrated=false 说明还是 seed 或默认值。
    agent.getContextRatio = () => {
        const key = modelKey(agent.config)
        return { ratio: meter.ratio(key), calibrated: meter.calibrated(key), source: meter.source(key) }
    }

    // 显式设一个倍率：立刻生效（忘掉之前学到的值），之后真实 usage 到达仍会覆盖它。
    agent.setContextRatio = ratio => {
        if (!(typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0)) throw new TypeError('contextRatio must be a positive number')
        agent.config = { ...agent.config, contextRatio: ratio } // 写回配置：Loop 每笔请求前会读它，和别的配置一样是活的。
        meter.forget(modelKey(agent.config))                    // 让新倍率立刻生效，而不是被之前学到的值挡住。
        meter.seed(ratio)
        return agent.getContextRatio()
    }

    return agent
}


// Agent 对外的公开面：create 造实例，其余是把内部零件也直接暴露给调用方复用。
const Agent = {
    version,              // 当前版本号，来自 package.json
    create,               // 创建一台独立 Agent，配置、工具、历史各自隔离
    tool: Tool,           // 工具能力：from / scan / adopt / execute / merge / pick / omit
    history: History,     // 历史消息块的构造器（user / assistant / tool / compact …）
    context: Context,     // 把历史裁剪成模型上下文
    compact: Compact,     // 把上下文压缩成一段总结
    llm: LLM,             // 底层模型请求封装，也可单独用来直接对话
    textTools: TextTools, // 纯文本模型的工具协议
    output: Output,       // 结构化输出的格式定义（AI SDK 的 Output）
    schema: z,            // 校验库，调用方不必另装
}

export default Agent
