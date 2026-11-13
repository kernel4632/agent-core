/*
新实现的包入口（TypeScript）：import { Agent } from '@kernel4632/agent-core'。

只导出 Agent（问模型的封装挂在 Agent.LLM.ask 上）和宿主会用到的类型。
切换完成前，旧入口 index.js 仍是 package.json 指向的实现；切换时删除旧文件并把 package.json 指到这里的产物。
*/

export { Agent } from './src/agent.ts'
export type {
    Config, CreateOptions, Input, Answer, Reason, Usage, Callbacks, Chunk,
    Message, CompactMessage, ErrorMessage, Draft, Role,
    ToolDefinition, ToolMeta, ToolCall, ToolResult, McpServer,
    AskRequest, Reply, RetryOptions, RetryFilter, ErrorKind,
    Protocol, ModelInput, MediaSwitch, ContextKeep, CacheOption,
} from './src/types.ts'
