/*
@kernel4632/agent-core 的类型声明。

这个包用 Bun 直接运行源码，没有编译期类型；这份文件是手写的公开 API 描述，
只覆盖调用方会碰到的部分。它会被 scripts/build.js 一起放进 dist，供 TS 用户补全。

AI SDK 的生成参数和 Zod 格式不进这个包的类型系统：它们原样透传，
这里用 `any` / `unknown` 表示，不假装知道它们的形状。
*/

// --- 连接配置 ---
export type Protocol = 'chat' | 'responses' | 'anthropic' | 'gemini'

export type Model = string | object

export type ToolMode = 'native' | 'text' | 'auto'

export interface Capabilities {
    image?: boolean
    audio?: boolean
    video?: boolean
    file?: boolean
    tools?: boolean
    structuredOutput?: boolean
    toolChoice?: boolean
    reasoning?: boolean
    usage?: boolean
}

export type CacheOption = boolean | { key?: string; retention?: string; body?: Record<string, unknown> }

// 重试过滤：函数直接对错误下判断（返回 false＝不重试）；
// 对象命中任一 skip 维度、或 shouldRetry 返回 false 时不重试。
export type RetryFilter =
    | ((error: any) => boolean)
    | {
        skipCodes?: number[]
        skipText?: string | RegExp
        skipKinds?: string[]
        shouldRetry?: (error: any) => boolean
    }

export interface Config {
    baseURL?: string
    apiKey?: string
    model?: Model
    protocol?: Protocol
    system?: string
    stream?: boolean
    cache?: CacheOption
    toolMode?: ToolMode
    capabilities?: Capabilities
    mediaFallback?: 'error' | 'strip'
    provider?: Record<string, any>
    maxToolOutput?: number
    maxTokens?: number
    compactThreshold?: number
    compact?: Partial<Config>
    output?: any
    maxSteps?: number
    maxToolConcurrency?: number
    retryBaseDelay?: number
    retryMaxDelay?: number
    retryMaxElapsed?: number
    retry?: RetryFilter
    requestTimeout?: number
    noToolPrompt?: string
    noToolRounds?: number
    [key: string]: any
}

// --- 用量与返回值 ---
export interface Usage {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
}

export type Reason = 'finished' | 'no-tool' | 'tool-stop' | 'step-limit'

export interface Answer {
    reason: Reason
    text: string
    output?: any
    steps: number
    usage: Usage
}

// --- 回调 ---
export interface Callbacks {
    onStart?: () => void | Promise<void>
    onLLMStart?: (request: { messages: unknown[]; tools: unknown }) => void | Promise<void>
    onLLMFinish?: (result: any) => void | Promise<void>
    onLLMEvent?: (event: any) => void | Promise<void>
    onPermission?: (permission: { sessionId: string; toolCallId: string; toolName: string; input: any; signal: AbortSignal }) => boolean | Promise<boolean>
    onRetry?: (info: { attempt: number; error: Error; delay: number }) => void
    onToolCall?: (call: { toolCallId: string; toolName: string; input: any; type?: string; title?: string; providerExecuted?: boolean; providerMetadata?: Record<string, any> }) => void | Promise<void>
    onToolOutput?: (output: { toolName: string; stream: string; data: unknown; toolCallId: string; input?: any }) => void
    onToolResult?: (result: { toolCallId: string; toolName: string; input?: any; output: any; result?: any; error?: string; type?: string; title?: string; providerExecuted?: boolean; providerMetadata?: Record<string, any> }) => void | Promise<void>
    onStep?: (step: { step: number; result: any; toolCalls: any[]; toolResults: any[] }) => void | Promise<void>
    onCompact?: (event: any) => void | Promise<void>
}

// --- 工具集合：scan / adopt / merge 都返回这个形状 ---
export interface ToolSet {
    schema: Record<string, any>
    handlers: Record<string, any>
}

// 内存工具对象的形状（AI SDK tool() 产物、MCP client.tools() 的单项都符合这个形状）
export interface ToolLike {
    name?: string           // 数组形式必填；record 形式从键名取；单个对象直接传时也必填
    description?: string
    inputSchema?: any       // 裸 JSON Schema / zod / AI SDK jsonSchema() 三种都认
    execute: (input: any, options?: { signal?: AbortSignal; abortSignal?: AbortSignal }) => any | Promise<any>
    toModelOutput?: (options: { output: any; input?: any; toolCallId?: string }) => any
    timeout?: number
    [key: string]: any
}

// adopt 接受的所有输入形状
export type ToolInput =
    | ToolSet                          // 已归一化，原样通过
    | ToolLike                         // 单个工具对象
    | ToolLike[]                       // 带 name 字段的工具对象数组
    | Record<string, ToolLike>         // record，名字从键来（AI SDK / MCP toolset 形状）
    | null
    | undefined

// --- 工具的扫描、接纳与执行 ---
export type ToolSource = string | URL | ToolInput
export interface ToolModule {
    from: (...sources: Array<ToolSource | Promise<ToolSource> | ToolSource[]>) => Promise<ToolSet>
    scan: (...directories: Array<string | URL | Array<string | URL>>) => Promise<ToolSet>
    adopt: (input: ToolInput) => ToolSet
    execute: (options: {
        name: string
        input?: Record<string, unknown>
        toolCallId?: string
        handlers: Record<string, any>
        signal?: AbortSignal
        onOutput?: (output: { toolName: string; stream: string; data: unknown }) => void
        limit?: number
        concurrency?: number
    }) => Promise<{ output: any; stop?: boolean; error?: string; interrupted?: boolean }>
    merge: (...sets: ToolSet[]) => ToolSet
}

// --- 历史块 ---
export type Role = 'user' | 'assistant' | 'tool'
export interface Message {
    id: string
    role: Role
    content: string | any[] | null
    compact?: boolean
}

export interface HistoryModule {
    user: (options: { id?: string; content: string | any[] }) => Message
    assistant: (options: { id?: string; content?: string | any[] | null; toolCalls?: Array<{ id: string; name: string; arguments?: any; input?: any }> }) => Message
    tool: (options: { id?: string; toolCallId: string; toolName: string; content: any }) => Message
    compact: (options: { id?: string; content: string }) => Message
    stored: (message: any) => Message
    turns: (history: Message[]) => Message[][]
    render: (history: Message[]) => string
    model: (message: Message, options?: Record<string, any>) => { role: Role; content: any }
    parts: (message: Message) => any[]
    answeredCalls: (messages: Message[]) => Set<string>
    mediaDefaults: Record<string, boolean>
}

// --- 上下文、压缩、底层 LLM ---
export interface ContextModule {
    build: (options: { history: Message[]; system?: string; tools?: Record<string, any>; budget?: number; ratio?: number; capabilities?: Capabilities; mediaFallback?: 'error' | 'strip' }) => { messages: any[]; readonly token: number }
}
export interface CompactModule {
    run: (options: Record<string, any>) => Promise<string>
}
export interface LLMModule {
    chat: (options: Record<string, any>) => Promise<any>
}
export interface TextToolsSpec {
    names: string[]
    params: Record<string, Record<string, string>>
    instructions: string
}
export interface TextToolsModule {
    prepare: (tools: Record<string, any>) => Promise<TextToolsSpec> | null
    parse: (text: string, spec: TextToolsSpec, options?: { loose?: boolean }) => { text: string; calls: any[] }
    downgrade: (messages: any[]) => any[]
    wrap: (messages: any[], spec: TextToolsSpec) => any[]
    read: (result: any, spec: TextToolsSpec, options?: { loose?: boolean }) => any
    refused: (error: any) => boolean
    remember: (llm: { model: any; protocol?: string; baseURL?: string }) => void
    remembered: (llm: { model: any; protocol?: string; baseURL?: string }) => boolean
}

// --- Agent 实例 ---
export interface SendOptions {
    input?: string | any[]
    history?: Message[]
    config?: Partial<Config>
    tools?: ToolSource | ToolSource[]     // 目录字符串 / URL / 数组也可以，send 时会现扫
    callbacks?: Callbacks
    signal?: AbortSignal
}

export interface AgentInstance {
    id: string
    history: Message[]
    config: Config
    tools: ToolSet
    callbacks: Callbacks
    running: { controller: AbortController; task: Promise<Answer | string> } | null // send 时是 Answer；compact 时是总结字符串。
    send: {
        (input: string | any[], options?: Omit<SendOptions, 'input'>): Promise<Answer>
        (options: SendOptions & { input: string | any[] }): Promise<Answer>
    }
    stop: () => Promise<{ ok: boolean }>
    compact: (options?: { onCompact?: Callbacks['onCompact']; onRetry?: Callbacks['onRetry']; signal?: AbortSignal }) => Promise<string>
}

export interface CreateOptions {
    id?: string
    history?: Message[]
    config?: Config
    tools?: ToolInput
    callbacks?: Callbacks
}

export interface Agent {
    version: string
    create: (options?: CreateOptions) => AgentInstance
    tool: ToolModule
    history: HistoryModule
    context: ContextModule
    compact: CompactModule
    llm: LLMModule
    textTools: TextToolsModule
    output: any
    schema: any
}

declare const Agent: Agent
export default Agent
