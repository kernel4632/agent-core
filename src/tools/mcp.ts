/*
MCP：远程工具连接，留在主进程（卡住断开连接即可，不需要子进程）。用官方 @ai-sdk/mcp 客户端。

调用示例：
    connect(agent.MCP.list, internal.MCPClients)                                    // Agent.create、MCP.open：立刻在后台开连，不等
    const MCPTools = connect(state.MCP, state.internal.MCPClients, callbacks.onWarning) // loop/run 每轮开头：同步返回此刻已连上的工具
    // { 'github_search': Tool, ... }——工具名加 `${server.name}_` 前缀，交给 tools/run 执行

规则（issue #30 Q9、Q10）：
- 元素是 { name, url, headers?, transport?, enabled? }；transport 默认 'http'（Streamable HTTP），老服务器写 'sse'；
- enabled: false 的元素等同于"列表里没有"：断开连接、工具这一轮就消失；改回 true（或删掉这个字段）立刻重新开连；
- 列表里新出现的连接、配置（url / headers / transport）变了的连接：在后台建立 / 重建；
- 列表里已经没有的连接：关闭并移出缓存；
- 停止用 abortSignal（tools/run 执行 MCP 工具时传入），不 kill；
- 工具清单在连接时取一次并随连接缓存；服务器端工具变化要等连接配置变化或重建实例后才会刷新（取舍：每轮都 list 会多一次往返）。

为什么完全异步（第一性原理）：MCP 是可选的外部能力，一台慢或坏的服务器不该让对话、请求或 stop() 多等哪怕一毫秒。
所以 connect 本身是同步的：只负责"该开连的开连、该关的关掉"，然后返回此刻 ready 的工具，从不 await 任何连接。
连接尽早开始（create 时、MCP.open 时、每轮开头发现新元素时），在后台连上的那一刻就算 ready，
下一次构建请求就会带上它的工具——一次 send 中途连上的，下一轮请求就能用，基本实时。

连不上（含超过 MCP_TIMEOUT）怎么报：记录停在 failed，原因先存在 error 上，由下一次读取它的轮次通过 onWarning 报一次、报完清掉。
为什么不在失败的那一刻报：onWarning 是 send 的回调，连接可能在没有 send 在跑时失败（create 之后、两次 send 之间），
那一刻手里没有回调；而且失败真正影响的是"下一次请求没有它的工具"，在那次请求开始时告诉宿主，时机正好对得上。
这样不需要额外的 create 级回调，警告也永远走同一条路。
不自动重连：反复重连一台坏服务器只会刷警告；要不要重试由用户决定，切一下这条连接的开关（MCP.close / MCP.open、enabled、改配置）就会重新连。
本文件只导入 utils/errors（tell），依赖 @ai-sdk/mcp；没有模块级可变状态。
*/

import type { Tool } from 'ai'
import { createMCPClient } from '@ai-sdk/mcp'
import type { Internal, MCPClient, MCPServer } from '../types.ts'
import { tell } from '../utils/errors.ts'

// 一次后台连接（握手 + 取工具清单）最长多久（毫秒）：超过就算连不上。它不阻塞任何东西，只决定多久之后报失败。
export const MCP_TIMEOUT = 15000

/*
connect：按文件头的规则同步 internal.MCPClients 与 servers（新连接在后台开始），并报出还没报过的连接失败，
返回此刻已连上的全部 MCP 工具（已加前缀）。同步函数，从不等待连接。返回的 Tool 保留 AI SDK 的 execute(input, { abortSignal }) 契约。
*/
export function connect(
    servers: MCPServer[],
    clients: Internal['MCPClients'],
    onWarning?: (warning: { path?: string; message: string }) => unknown,
): Record<string, Tool> {
    const wanted = new Map(servers.filter(server => server.enabled !== false).map(server => [server.name, server])) // 临时关闭的不算。
    // 列表里已经没有的连接：关掉并移出缓存（关闭失败不影响其它）。
    for (const [name, client] of clients) if (!wanted.has(name)) { clients.delete(name); void client.close().catch(() => {}) }
    for (const server of wanted.values()) {
        const key = JSON.stringify([server.url, server.headers ?? {}, server.transport ?? 'http'])
        const existing = clients.get(server.name)
        if (existing?.key === key) continue                                 // 配置没变：复用（包括 failed——不自动重试）。
        if (existing) { clients.delete(server.name); void existing.close().catch(() => {}) } // 配置变了：重建。
        const entry: MCPClient = { key, status: 'connecting', tools: {}, close: async () => {} }
        clients.set(server.name, entry)
        const attempt = (async () => {
            const client = await createMCPClient({ transport: { type: server.transport ?? 'http', url: server.url, headers: server.headers } })
            try { return { client, tools: await client.tools() as Record<string, Tool> } } catch (error) { void client.close().catch(() => {}); throw error }
        })()
        // 后台收尾：连上就标 ready（下一次构建请求起就带上它的工具）；失败把原因存起来，等轮次来报。
        void (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined
            const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`连接超时（${MCP_TIMEOUT}ms）`)), MCP_TIMEOUT); timer.unref?.() })
            try {
                const { client, tools } = await Promise.race([attempt, timeout])
                if (clients.get(server.name) !== entry) { void client.close().catch(() => {}); return } // 连接中被关掉 / 替换：晚到的连接直接关。
                Object.assign(entry, { status: 'ready', tools, close: () => client.close() })
            } catch (error) {
                void attempt.then(({ client }) => client.close()).catch(() => {}) // 超时后才连上的也关掉。
                if (clients.get(server.name) !== entry) return                  // 已被关掉 / 替换：这次失败与宿主无关，不报。
                Object.assign(entry, { status: 'failed', error: (error as Error)?.message ?? String(error) })
            } finally { clearTimeout(timer) }
        })()
    }
    // 合成这一轮的工具表：只含此刻已连上的；名字加 `${name}_` 前缀，不同服务器的同名工具互不覆盖。
    // 顺带报出还没报过的失败（有 onWarning 时才报并清掉；create / MCP.open 开连时没有回调，留给下一轮）。
    const result: Record<string, Tool> = {}
    for (const [name, client] of clients) {
        if (client.status === 'ready') for (const [toolName, tool] of Object.entries(client.tools)) result[`${name}_${toolName}`] = tool
        if (client.error !== undefined && onWarning) {
            void tell(onWarning, { message: `MCP 服务器 ${name} 连接失败，已跳过（切换这条连接的开关可重试）：${client.error}` })
            delete client.error
        }
    }
    return result
}

/*
close：立即断开连接（agent.MCP.close 用），只动连接缓存，不改 MCP.list——"之后别再连"由调用方把 enabled 置为 false 表达。
- 给了 name：只断开这一条；
- 不给 name：断开全部并清空缓存（例如 Agent 被丢弃前立即释放连接；宿主清空 MCP.list 时下一轮 connect 也会做同样的事）。
先移出缓存再关：连接中的那次连上后发现自己已不在缓存，会自己关掉；关闭失败也已移出，下一轮不会再用它。
返回是否断开了至少一条已连上的连接（连接中 / 失败的记录只移出缓存）。单个关闭失败不影响其它。
*/
export async function close(clients: Internal['MCPClients'], name?: string): Promise<boolean> {
    const picked = name === undefined ? [...clients.values()] : clients.has(name) ? [clients.get(name)!] : []
    if (name === undefined) clients.clear()
    else clients.delete(name)
    await Promise.all(picked.map(client => client.close().catch(() => {})))
    return picked.some(client => client.status === 'ready')
}
