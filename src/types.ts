/*
共享类型：整个 src/ 只有这一份类型定义，这里不写任何逻辑、不导入任何本项目文件。

为什么单独成文件：类型如果放在 agent.ts，loop / context 为了拿 State 就得反过来导入 agent，
破坏"依赖只往下指"的规则。所以所有文件都 `import type` 这里，它自己只引用 AI SDK 的类型。

分组：
1. 配置（Config 及其子项）——宿主随时可改，下一轮生效；
2. 历史消息（Message）——AI SDK 标准消息 + id，外加 compact / error 两种自定义 role；
3. 工具（ToolDefinition 工具文件契约、ToolMeta 元数据、McpServer 连接配置、调用与结果）；
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
export interface MediaSwitch { image?: boolean; audio?: boolean; video?: boolean; file?: boolean }

// 压缩后的上下文怎么拼：开场 head 轮 → 最新总结 → 总结前最近 beforeSummary 轮 → 总结后全部原文。
// 单位都是"用户回合"；budget 只约束 head + beforeSummary 两段，基数是 maxContextTokens，超出先丢最早的一轮。
export interface ContextKeep { head?: number; beforeSummary?: number; budget?: number }

// 提示词缓存：true 用默认键；对象自定义键、保留时长或额外请求体；false 关闭。
export type CacheOption = boolean | { key?: string; retention?: string; body?: Record<string, unknown> }

// 重试过滤：函数直接判断（返回 false = 不重试）；对象命中任一 skip 维度即不重试。
export type RetryFilter = ((error: unknown) => boolean) | { skipCodes?: number[]; skipText?: string | RegExp; skipKinds?: ErrorKind[] }

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
    media?: MediaSwitch
    mediaFallback?: 'error' | 'strip'         // 发了模型不支持的媒体：报错，或只留文字
    provider?: Record<string, unknown>        // 原样透传给 AI SDK 的生成参数
    maxTokens?: number                        // 单次生成的最大输出 token
    maxToolOutput?: number                    // 单个工具结果最多保留多少字符
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
export interface McpServer { name: string; url: string; headers?: Record<string, string>; transport?: 'http' | 'sse' }

// 模型发出的一次工具调用。
export interface ToolCall { toolCallId: string; toolName: string; input: unknown }

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
    stream?: boolean
    cache?: CacheOption
    provider?: Record<string, unknown>
    maxTokens?: number
    output?: unknown
    retry?: RetryOptions
    signal?: AbortSignal
    onRetry?: (info: { attempt: number; error: Error; delay: number }) => void
}

// 流式片段：简化后的形状，不暴露 AI SDK 原始事件。tool-result 由 loop 在执行完工具后补发。
export type Chunk =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool-call'; call: ToolCall }
    | { type: 'tool-result'; result: ToolResult }
    | { type: 'finish'; usage: Usage }

// 用量：五个字段都给数字，缺的补 0，方便宿主累加。
export interface Usage { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

// ask 的统一结果：流式与非流式完全一致。messages 是要追加进 history 的 AI SDK 消息（不带 id）。
export interface Reply { text: string; toolCalls: ToolCall[]; usage: Usage; output?: unknown; messages: ModelMessage[] }

// 错误分类：抛出的模型错误都带 kind，宿主按它分支。
export type ErrorKind = 'aborted' | 'auth' | 'limit' | 'timeout' | 'server' | 'network' | 'request' | 'overflow' | 'unknown'

// ---------- 5. 回调与返回值 ----------

// 循环为什么结束：模型正常收尾 / 连续不调工具 / 工具要求停止。
export type Reason = 'finished' | 'no-tool' | 'tool-stop'

// send 的返回值：和回调里实时反馈的内容一致。
export interface Answer { reason: Reason; text: string; usage: Usage; output?: unknown }

// decide 的判断结果：继续、挂一条临时提醒后继续、或结束并给出原因。
export type Decision = { action: 'continue' } | { action: 'remind'; reminder: string } | { action: 'end'; reason: Reason }

// 每次 send 传入的回调；全部可选，没传的跳过。渲染 / 钩子由宿主按 ToolResult.path 分发到插件。
export interface Callbacks {
    onChunk?: (chunk: Chunk) => void
    onPermission?: (call: ToolCall & { path?: string }) => boolean | Promise<boolean>
    onInject?: (info: { tokens: number; budget: number; ratio: number }) => string | undefined | Promise<string | undefined>
    onToolCall?: (call: ToolCall & { path?: string }) => void
    onToolOutput?: (output: { toolCallId: string; stream: 'stdout' | 'stderr'; data: string }) => void
    onToolResult?: (result: ToolResult) => void
    onStep?: (step: { step: number; reply: Reply; results: ToolResult[] }) => void
    onCompact?: (info: { reason: 'auto' | 'manual'; before: number; after: number; usage: Usage }) => void
    onRetry?: (info: { attempt: number; error: Error; delay: number }) => void
    onWarning?: (warning: { path?: string; message: string }) => void   // 坏工具文件被跳过等
}

// Agent.create 的入参：配置平铺，另带 id、初始 history、工具路径与 MCP 连接。
export type CreateOptions = Config & { id?: string; history?: Message[]; tools?: string[]; mcp?: McpServer[]; contextRatio?: number; ratios?: Record<string, number> }

// send 的输入：一句话或内容块数组；省略 = 从当前历史继续。
export type Input = string | Exclude<UserContent, string>

// ---------- 6. 运行时状态 ----------

// 不公开的内部状态：只存在于 Agent 实例里，作为参数传给 loop / tools，绝不放在模块里。
export interface Internal {
    procs: Set<Subprocess>                                      // 本实例正在跑的子进程，stop() 全杀
    toolCache: Map<string, ToolMeta>                            // 路径 → 元数据，mtime 变了就重读
    mcpClients: Map<string, { key: string; close: () => Promise<void>; tools: Record<string, Tool> }> // name → 已连接的 MCP
    controller: AbortController | null                          // 当前运行的取消器
    running: Promise<unknown> | null                            // 当前运行（send 或 compact）
    warned: Set<string>                                         // 已提醒过的警告，避免每轮重复
}

// loop 看到的状态：公开字段每次读取都取 Agent 上的最新值（宿主可整份替换），internal 是私有部分。
export interface State {
    readonly id: string
    readonly config: Config
    readonly history: Message[]
    readonly tools: string[]
    readonly mcp: McpServer[]
    contextRatio: number | undefined
    readonly ratios: Record<string, number>
    readonly internal: Internal
}
