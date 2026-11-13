/*
MCP：远程工具连接，留在主进程（卡住断开连接即可，不需要子进程）。用官方 @ai-sdk/mcp 客户端。

调用示例（在 loop/run 每轮开头）：
    const mcpTools = await connect(state.mcp, state.internal.mcpClients, callbacks.onWarning)
    // { 'github_search': Tool, ... }——工具名加 `${server.name}_` 前缀，交给 tools/run 执行

为什么每轮都调：agent.mcp 和 agent.tools 一样是宿主随时可改的数组。已连接的客户端缓存在
Agent 实例的 internal.mcpClients 里（按 name，配置变了就重连），所以平时没有额外开销。

规则（issue #30 Q9、Q10）：
- 元素是 { name, url, headers?, transport? }；transport 默认 'http'（Streamable HTTP），老服务器写 'sse'；
- 列表里新出现的连接、配置（url / headers / transport）变了的连接：建立 / 重建；
- 列表里已经没有的连接：关闭并移出缓存；
- 某个服务器连不上：跳过并通过 onWarning 警告，其它照常；
- 停止用 abortSignal（tools/run 执行 MCP 工具时传入），不 kill。
本文件不导入任何本项目文件，只依赖 @ai-sdk/mcp；没有模块级可变状态。
*/

import type { Tool } from 'ai'
import { createMCPClient } from '@ai-sdk/mcp'
import type { Internal, McpServer } from '../types.ts'

/*
connect：按文件头的规则同步 internal.mcpClients 与 servers，返回这一轮全部 MCP 工具（已加前缀）。
连接与 tools() 并行进行；返回的 Tool 保留 AI SDK 的 execute(input, { abortSignal }) 契约。
*/
export async function connect(
    servers: McpServer[],
    clients: Internal['mcpClients'],
    onWarning?: (warning: { path?: string; message: string }) => void,
): Promise<Record<string, Tool>> {
    throw new Error('TODO')
}

/*
closeAll：关闭全部已连接的 MCP 客户端并清空缓存。宿主把 agent.mcp 清空时下一轮 connect 也会做同样的事；
这个函数给需要立即释放连接的场景用（例如 Agent 被丢弃前）。单个关闭失败不影响其它。
*/
export async function closeAll(clients: Internal['mcpClients']): Promise<void> {
    throw new Error('TODO')
}
