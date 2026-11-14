/*
共享类型：整个 src/ 只有这一份类型定义，这里不写任何逻辑、不导入任何本项目文件。

为什么单独成文件：类型如果放在 agent.ts，loop / context 为了拿 State 就得反过来导入 agent，
破坏"依赖只往下指"的规则。所以所有文件都 `import type` 这里，它自己只引用 AI SDK 的类型。

分组：
1. 配置（Config 及其子项）——宿主随时可改，下一轮生效；
2. 历史消息（Message）——AI SDK 标准消息 + id，外加 compact / error 两种自定义 role；
3. 工具（ToolDefinition 工具文件契约、ToolMeta 元数据、MCPServer 连接配置、调用与结果）；
4. 问模型（AskRequest / Reply / Chunk）——Agent.LLM.ask 的公开契约；
5. 回调与返回值（Callbacks / Answer）；
6. 运行时状态（State / Internal）——loop 通过参数拿到它，从不导入 agent。
*/

import type { LanguageModel, ModelMessage, UserContent, Tool, JSONSchema7 } from 'ai'
import type { Subprocess } from 'bun'

// ---------- 1. 配置 ----------

// 模型协议只是一个参数：同一份请求数据，换协议就换 AI SDK 的 provider。
export type Protocol = 'chat' | 'responses' | 'anthropic' | 'gemini'

// 模型：字符串（配 baseURL / apiKey / protocol 现连），或宿主自己建好的 AI SDK 模型实例。
export type ModelInput = string | LanguageModel

// 按媒体类型逐项开关；没写的一律视为 false（不发）。对象而不是布尔，因为多数模型只支持图片。
// 没开的类型在发给模型前换成一句占位文字（history 原样保留，换个支持的模型马上能看到原件）。
export interface MediaSwitch { image?: boolean; audio?: boolean; video?: boolean; file?: boolean }

// 思考内容回传：有的供应商强制要求把上一轮的思考原样发回（如部分推理模型的工具调用），有的直接拒收。
// 'send' 原样发回，'strip' 发送前摘掉（history 里始终保留）。
export type ReasoningMode = 'send' | 'strip'

// 压缩后的上下文怎么拼：开场 head 轮 → 最新总结 → 总结前最近 beforeSummary 轮 → 总结后全部原文。
// 单位都是"用户回合"；budget 只约束 head + beforeSummary 两段，基数是 maxContextTokens，超出先丢最早的一轮。
export interface ContextKeep { head?: number; beforeSummary?: number; budget?: number }

// 提示词缓存：true 用默认键；对象自定义键、保留时长或额外请求体；false 关闭。
export type CacheOption = boolean | { key?: string; retention?: string; body?: Record<string, unknown> }

// 重试过滤：函数直接判断（返回 false = 不重试）；对象的 shouldRetry 返回 false、或命中任一 skip 维度即不重试。
export type RetryFilter = ((error: unknown) => boolean) | { shouldRetry?: (error: unknown) => boolean; skipCodes?: number[]; skipText?: string | RegExp; skipKinds?: ErrorKind[] }

// 重试参数：问模型时由 config 的平铺字段收拢成这一份，Agent.LLM.ask 单独用时直接传它。
export interface RetryOptions {
    maxTries?: number      // 最多再重试几次；不设 = 不限，0 = 不重试
    maxElapsed?: number    // 重试总时长上限（毫秒）；不设 = 不限
    baseDelay?: number     // 第一次退避的基数（毫秒）
    maxDelay?: number      // 单次退避上限（毫秒）
    timeout?: number       // 单次请求超时（毫秒）；不设 = 不限
    filter?: RetryFilter   // 宿主自己的"不想重试"规则
}

// Agent 的活配置：每一轮请求前现读，宿主改了下一轮就生效。默认值写在读它的那个文件里，
// 这样宿主整份替换 agent.config 也不会丢默认值。
export interface Config {
    model: ModelInput
    baseURL?: string
    apiKey?: string
    protocol?: Protocol
    system?: string
    stream?: boolean
    cache?: CacheOption
    textTools?: boolean                       // 显式开关：打开后用文字协议模拟工具调用
    media?: MediaSwitch                       // 发给模型的媒体类型开关；没开的换成占位文字，不报错、不改 history
    includeUsage?: boolean                    // chat 协议流式时请求 usage（stream_options），默认 true；不认这个字段的中转站设 false
    reasoning?: ReasoningMode                 // 历史里的思考内容发不发回模型，默认 'strip'（与旧版一致）
    provider?: Record<string, unknown>        // 原样透传给 AI SDK 的生成参数
    maxTokens?: number                        // 单次生成的最大输出 token
    maxToolOutput?: number                    // 单个工具结果最多保留多少字符；默认不截断（截断时保留开头 70% + 结尾 30%）
    maxContextTokens?: number                 // 上下文预算，默认 128000；Infinity 关闭自动压缩
    compactThreshold?: number                 // 估算达到预算的这个比例就压缩，默认 0.8
    compact?: Partial<Config>                 // 压缩请求单独用的模型 / 参数（省钱）
    context?: ContextKeep                     // 压缩后保留规则，默认 { head: 0, beforeSummary: 10, budget: 0.3 }
    output?: unknown                          // 结构化输出格式；有值就用，没值就不用
    noToolRounds?: number                     // 连续几轮不调工具就结束，默认 3
    noToolPrompt?: string                     // 不调工具时临时挂上的提醒（不进 history）
    retryMaxTries?: number
    retryMaxElapsed?: number
    retryBaseDelay?: number
    retryMaxDelay?: number
    requestTimeout?: number
    retry?: RetryFilter
}

// ---------- 2. 历史消息 ----------

// 总结：history 里的一条普通消息，只追加；build 时把最新一条折进 system。
export interface CompactMessage { id: string; role: 'compact'; content: string }
// 宿主的失败记录：存进 history 供渲染，但永远不发给模型。
export interface ErrorMessage { id: string; role: 'error'; content: string; request?: unknown }
// history 的一条：AI SDK 标准消息带 id，或上面两种自定义 role。
export type Message = (ModelMessage & { id: string }) | CompactMessage | ErrorMessage
export type Role = Message['role']
// 追加前的草稿：id 可省，append 时补上。
export type Draft = Message extends infer M ? (M extends Message ? Omit<M, 'id'> & { id?: string } : never) : never

// ---------- 3. 工具 ----------

// 工具文件的默认导出：零依赖（不依赖 agent-core）的纯定义，读起来像文档。一个文件一个工具。
export interface ToolDefinition {
    name: string
    description: string
    parameters: JSONSchema7                                   // 只收 JSON Schema
    run: (args: any) => unknown | Promise<unknown>            // 只有 args；停止 = 直接杀子进程
    toModelOutput?: (options: { output: unknown; input: unknown; toolCallId: string }) => unknown // 可选：把结果改写成给模型看的输出块（与 AI SDK 同签名）
    timeout?: number                                          // 可选：单次执行超时（毫秒）
}

// 子进程读回来的元数据：除了 run 以外的全部，加上来源路径和读取时的修改时间。
export interface ToolMeta {
    name: string
    description: string
    parameters: JSONSchema7
    timeout?: number
    path: string        // 工具文件的绝对路径，宿主据此映射回插件
    mtime: number       // 读取时的文件修改时间，缓存命中判据
}

// MCP 连接配置：核心负责连接，工具名加 `${name}_` 前缀。默认 Streamable HTTP，老服务器用 sse。
// enabled: false = 临时关闭（每轮现读：断开连接、工具下一轮消失；改回 true 下一轮重连），省略视为 true。
export interface MCPServer { name: string; url: string; headers?: Record<string, string>; transport?: 'http' | 'sse'; enabled?: boolean }

// 模型发出的一次工具调用。invalid 有值表示这次调用本身不合法（参数解析失败、不符合 schema、文字工具写坏），
// 值是原因：loop 不问权限、不执行，直接把原因作为错误结果交给模型重写。
export interface ToolCall { toolCallId: string; toolName: string; input: unknown; invalid?: string }

// 一次工具调用的结果：错误也是结果（写进 history 交给模型），stop 表示工具要求结束循环。
export interface ToolResult extends ToolCall {
    output: unknown
    error?: string
    stop?: boolean
    cancelled?: boolean   // 被 stop() 打断：补一条"已取消"，保证 history 不坏
    path?: string         // 普通工具的来源文件；MCP 工具没有
}

// ---------- 4. 问模型 ----------

// Agent.LLM.ask 的入参：完整传入，不依赖任何实例。tools 只要描述，不要执行器。
export interface AskRequest {
    model: ModelInput
    baseURL?: string
    apiKey?: string
    protocol?: Protocol
    system?: string
    messages: ModelMessage[]
    tools?: Record<string, { description: string; parameters: JSONSchema7 }>
    textTools?: boolean
    reasoning?: ReasoningMode                                 // 默认 'strip'：发送前摘掉 messages 里的思考块
    includeUsage?: boolean                                    // chat 协议是否请求流式 usage，默认 true
    stream?: boolean
    cache?: CacheOption
    provider?: Record<string, unknown>
    maxTokens?: number
    output?: unknown
    retry?: RetryOptions
    signal?: AbortSignal
    onRetry?: (info: RetryInfo) => unknown
}

// 一次重试通知：第几次重试、最多几次（Infinity = 不限）、这次的错误、等多久（毫秒）。
export interface RetryInfo { attempt: number; maxTries: number; error: Error; delay: number }

// 为什么压缩：auto = 估算到阈值；overflow = 模型报上下文超长后强制压缩再重发；manual = 宿主调 agent.compact()。
export type CompactReason = 'auto' | 'overflow' | 'manual'

// 估算比例的来源：usage = 真实用量学到的；host = 宿主给的冷启动 contextRatio；default = 默认 0.6。
export type RatioSource = 'usage' | 'host' | 'default'

// 流式片段：简化后的形状，不暴露 AI SDK 原始事件。tool-result 由 loop 在执行完工具后补发。
// 压缩期间：先发一条 compact-start，之后压缩模型的 reasoning / text / finish 片段都带 compact: true，
// 宿主用同一个 onChunk 就能实时展示"正在压缩：模型在想什么、总结正文是什么"，又不会和正式回答混在一起。
export type Chunk = (
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool-call'; call: ToolCall }
    | { type: 'tool-result'; result: ToolResult }
    | { type: 'finish'; usage: Usage }
    | { type: 'compact-start'; reason: CompactReason }
) & { compact?: true }

// 用量：五个字段都给数字，缺的补 0，方便宿主累加。
export interface Usage { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

// ask 的统一结果：流式与非流式完全一致。messages 是要追加进 history 的 AI SDK 消息（不带 id）。
// reasoning 是这次回复的思考全文（没有就是空串），宿主可以拿它和流式推送过的 reasoning 片段核对。
export interface Reply { text: string; reasoning: string; toolCalls: ToolCall[]; usage: Usage; output?: unknown; messages: ModelMessage[] }

// 错误分类：抛出的模型错误都带 kind，宿主按它分支。
export type ErrorKind = 'aborted' | 'auth' | 'limit' | 'timeout' | 'server' | 'network' | 'request' | 'overflow' | 'unknown'

// ---------- 5. 回调与返回值 ----------

// 循环为什么结束：模型正常收尾 / 连续不调工具 / 工具要求停止。
export type Reason = 'finished' | 'no-tool' | 'tool-stop'

// send 的返回值：和回调里实时反馈的内容一致。steps 是这次 send 发给模型的轮数（重试算同一轮，压缩不算）。
export interface Answer { reason: Reason; text: string; steps: number; usage: Usage; output?: unknown }

// stop() 的结果：只在本实例的子进程全部退出、当前运行（send / compact）已经收尾之后才兑现。
export interface Stopped {
    stopped: true          // 固定为 true：拿到这个值就说明已经完全停下
    wasRunning: boolean    // 调用时是否有运行在进行（没有时 stop 什么也不用做）
    killed: number         // 被杀掉的工具子进程数（均已确认退出）
}

// MCP.close / MCP.open 的结果。
export interface MCPToggle {
    name: string
    found: boolean         // MCP.list 里有没有这个名字；没有就什么也没改
    enabled: boolean       // 改完之后的 enabled
    closed?: boolean       // 仅 MCP.close：是否真的断开了一条已连上的连接（连接中 / 失败的记录则为 false）
    connected?: boolean    // 仅 MCP.open：连接结果出来后是否已连上
    error?: string         // 仅 MCP.open：没连上的原因（连接失败、超时、等待期间被关掉）
}

// agent.MCP：MCP 连接的宿主入口。list 是活配置（每轮现读，可原地增删，也可整份换成新数组）；
// open / close 是需要"立即"语义的两个动作，按 name 找 list 里的元素。
export interface MCP {
    list: MCPServer[]
    open: (name: string) => Promise<MCPToggle>        // enabled 置 true 并开连，等这一条的连接结果（只有调用方等，请求不等）
    close: (name: string) => Promise<MCPToggle>       // enabled 置 false，并立即断开
}

// decide 的判断结果：继续、挂一条临时提醒后继续、或结束并给出原因。
export type Decision = { action: 'continue' } | { action: 'remind'; reminder: string } | { action: 'end'; reason: Reason }

// 每次 send 传入的回调；全部可选，没传的跳过。渲染 / 钩子由宿主按 ToolResult.path 分发到插件。
export interface Callbacks {
    onChunk?: (chunk: Chunk) => unknown
    onPermission?: (call: ToolCall & { path?: string }) => boolean | Promise<boolean>   // 必须严格返回布尔值，非 true 一律拒绝
    onInject?: (info: { tokens: number; budget: number; compactThreshold: number; ratio: number; ratioSource: RatioSource }) => string | undefined | Promise<string | undefined>
    onToolCall?: (call: ToolCall & { path?: string }) => unknown        // 会被等待：工具开跑前宿主先把调用显示出来
    onToolOutput?: (output: { toolCallId: string; stream: 'stdout' | 'stderr'; data: string }) => unknown
    onToolResult?: (result: ToolResult) => unknown
    onStep?: (step: { step: number; reply: Reply; results: ToolResult[] }) => unknown   // 会被等待：这一轮已写进 history，宿主可在这里安全持久化
    onCompact?: (info: CompactInfo) => unknown
    onRetry?: (info: RetryInfo) => unknown
    onWarning?: (warning: { path?: string; message: string }) => unknown   // 坏工具文件被跳过、history 里有发不出去的消息等
}

// 压缩完成的通知：为什么压、总结正文、压缩前后的估算，以及估算是怎么来的（排查"为什么压"用）。
export interface CompactInfo {
    reason: CompactReason
    summary: string        // 写进 history 的总结正文
    before: number         // 压缩前估算的输入 token
    after: number          // 压缩后估算的输入 token
    budget: number         // 上下文预算 maxContextTokens
    compactThreshold: number
    ratio: number          // 估算用的每字符 token 比例
    ratioSource: RatioSource
    chars: number          // 压缩前上下文的文字字符数
    media: number          // 压缩前上下文的媒体块数
    usage: Usage           // 这一笔压缩请求的用量
}

// Agent.create 的入参：配置平铺，另带 id、初始 history、工具路径与 MCP 连接。
export type CreateOptions = Config & { id?: string; history?: Message[]; tools?: string[]; MCP?: MCPServer[]; contextRatio?: number; ratios?: Record<string, number> }

// send 的输入：一句话或内容块数组；省略 = 从当前历史继续。
export type Input = string | Exclude<UserContent, string>

// ---------- 6. 运行时状态 ----------

// 不公开的内部状态：只存在于 Agent 实例里，作为参数传给 loop / tools，绝不放在模块里。
export interface Internal {
    procs: Set<Subprocess>                                      // 本实例正在跑的子进程，stop() 全杀
    toolCache: Map<string, ToolMeta>                            // 路径 → 元数据，mtime 变了就重读
    MCPClients: Map<string, MCPClient>                          // name → MCP 连接（连接中 / 已连上 / 失败）
    controller: AbortController | null                          // 当前运行的取消器
    running: Promise<unknown> | null                            // 当前运行（send 或 compact）
    warned: Set<string>                                         // 已提醒过的警告，避免每轮重复
}

// 一条 MCP 连接的记录：连接在后台进行，轮次从不等它，只读它此刻的状态。
// failed 的记录一直留着，不发警告、不自动重试；用户 MCP.open（或改配置 / 切 enabled）才会重连。
export interface MCPClient {
    key: string                                       // url + headers + transport，变了就重建
    status: 'connecting' | 'ready' | 'failed'
    tools: Record<string, Tool>                       // ready 之后才有内容
    error?: string                                    // failed 时的原因（MCP.open 返回给用户看）
    pending: Promise<void>                            // 这次连接的后台任务（永不拒绝）；只有 MCP.open 会等它
    close: () => Promise<void>                        // 断开；连接中调用时，连上后立即关掉
}

// loop 看到的状态：公开字段每次读取都取 Agent 上的最新值（宿主可整份替换），internal 是私有部分。
export interface State {
    readonly id: string
    readonly config: Config
    readonly history: Message[]
    readonly tools: string[]
    readonly MCP: MCPServer[]                                   // agent.MCP.list
    contextRatio: number | undefined
    readonly ratios: Record<string, number>
    readonly internal: Internal
}
