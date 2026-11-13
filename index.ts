/*
包入口：import { Agent } from '@kernel4632/agent-core'。

只导出 Agent（问模型的封装挂在 Agent.LLM.ask 上）和宿主会用到的类型。
发布时 scripts/build.ts 把它打成单文件 dist/agent-core.js，类型声明生成到 dist/types/。
*/

export { Agent } from './src/agent.ts'
export type {
    Config, CreateOptions, Input, Answer, Reason, Usage, Callbacks, Chunk, Stopped, McpToggle,
    Message, CompactMessage, ErrorMessage, Draft, Role,
    ToolDefinition, ToolMeta, ToolCall, ToolResult, McpServer,
    AskRequest, Reply, RetryOptions, RetryFilter, ErrorKind,
    Protocol, ModelInput, MediaSwitch, ReasoningMode, ContextKeep, CacheOption,
} from './src/types.ts'
