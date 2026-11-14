/*
MCP：远程工具连接，留在主进程（卡住断开连接即可，不需要子进程）。用官方 @ai-sdk/mcp 客户端。

调用示例（在 loop/run 每轮开头）：
    const MCPTools = await connect(state.MCP, state.internal.MCPClients, callbacks.onWarning, signal)
    // { 'github_search': Tool, ... }——工具名加 `${server.name}_` 前缀，交给 tools/run 执行；只含已连上的

为什么每轮都调：agent.MCP.list 和 agent.tools 一样是宿主随时可改的数组。连接记录缓存在
Agent 实例的 internal.MCPClients 里（按 name，配置变了就重建），所以平时没有额外开销。

规则（issue #30 Q9、Q10）：
- 元素是 { name, url, headers?, transport?, enabled? }；transport 默认 'http'（Streamable HTTP），老服务器写 'sse'；
- enabled: false 的元素等同于"列表里没有"：断开连接、工具这一轮就消失；改回 true（或删掉这个字段）下一轮重连；
- 列表里新出现的连接、配置（url / headers / transport）变了的连接：在后台建立 / 重建，不阻塞这一轮；
- 列表里已经没有的连接：关闭并移出缓存；
- 停止用 abortSignal（tools/run 执行 MCP 工具时传入），不 kill；
- 工具清单在连接时取一次并随连接缓存；服务器端工具变化要等连接配置变化或重建实例后才会刷新（取舍：每轮都 list 会多一次往返）。

为什么连接放后台、连不上不重试（第一性原理）：MCP 是可选的外部能力，一台连不上的服务器不该拖住对话本身，
也不该拖住 stop()。所以连接在后台跑，轮次最多等 MCP_GRACE（刚打开的连接通常这么久就连上了，第一句话就能用上它的工具；
stop() 一到立刻不等），之后连上了的下一轮才出现。连不上（含超过 MCP_TIMEOUT）就通过 onWarning 报一次，记录停在 failed：
不自动重连——反复重连一台坏服务器每轮都在烧时间、刷警告；要不要重试由用户决定，切一下这条连接的开关
（MCP.close / MCP.open、enabled、改配置）就会重新连。
本文件只导入 utils/errors（tell），依赖 @ai-sdk/mcp；没有模块级可变状态。
*/

import type { Tool } from 'ai'
import { createMCPClient } from '@ai-sdk/mcp'
import type { Internal, MCPClient, MCPServer } from '../types.ts'
import { tell } from '../utils/errors.ts'

// 一轮最多等正在连接的服务器多久（毫秒）：够一次正常握手，又不至于让坏服务器明显拖慢对话。
export const MCP_GRACE = 2000
// 一次连接（握手 + 取工具清单）最长多久（毫秒）：超过就算连不上，报警告，不再等。
export const MCP_TIMEOUT = 15000

/*
connect：按文件头的规则同步 internal.MCPClients 与 servers，返回这一轮已连上的全部 MCP 工具（已加前缀）。
新连接在后台进行；本轮最多等 MCP_GRACE，signal 一 abort 就不等。返回的 Tool 保留 AI SDK 的 execute(input, { abortSignal }) 契约。
*/
export async function connect(
    servers: MCPServer[],
    clients: Internal['MCPClients'],
    onWarning?: (warning: { path?: string; message: string }) => unknown,
    signal?: AbortSignal,
): Promise<Record<string, Tool>> {
    const wanted = new Map(servers.filter(server => server.enabled !== false).map(server => [server.name, server])) // 临时关闭的不算。
    // 列表里已经没有的连接：关掉并移出缓存（关闭失败不影响其它）。
    for (const [name, client] of clients) if (!wanted.has(name)) { clients.delete(name); void client.close().catch(() => {}) }
    for (const server of wanted.values()) {
        const key = JSON.stringify([server.url, server.headers ?? {}, server.transport ?? 'http'])
        const existing = clients.get(server.name)
        if (existing?.key === key) continue                                 // 配置没变：复用（包括 failed——不自动重试）。
        if (existing) { clients.delete(server.name); void existing.close().catch(() => {}) } // 配置变了：重建。
        const entry: MCPClient = { key, status: 'connecting', tools: {}, pending: Promise.resolve(), close: async () => {} }
        const attempt = (async () => {
            const client = await createMCPClient({ transport: { type: server.transport ?? 'http', url: server.url, headers: server.headers } })
            try { return { client, tools: await client.tools() as Record<string, Tool> } } catch (error) { void client.close().catch(() => {}); throw error }
        })()
        entry.pending = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined
            const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`连接超时（${MCP_TIMEOUT}ms）`)), MCP_TIMEOUT); timer.unref?.() })
            try {
                const { client, tools } = await Promise.race([attempt, timeout])
                if (clients.get(server.name) !== entry) { void client.close().catch(() => {}); return } // 连接中被关掉 / 替换：晚到的连接直接关。
                Object.assign(entry, { status: 'ready', tools, close: () => client.close() })
            } catch (error) {
                void attempt.then(({ client }) => client.close()).catch(() => {}) // 超时后才连上的也关掉。
                if (clients.get(server.name) !== entry) return                  // 已被关掉 / 替换：这次失败与宿主无关，不报。
                entry.status = 'failed'
                void tell(onWarning, { message: `MCP 服务器 ${server.name} 连接失败，已跳过（切换这条连接的开关可重试）：${(error as Error)?.message ?? String(error)}` })
            } finally { clearTimeout(timer) }
        })()
        clients.set(server.name, entry)
    }
    // 等正在连接的服务器一小会儿：全部有结果、MCP_GRACE 到了、或 stop() 了，三者先到为准；用完就摘掉监听。
    const waiting = [...clients.values()].filter(client => client.status === 'connecting').map(client => client.pending)
    if (waiting.length && !signal?.aborted) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, MCP_GRACE)
        signal?.addEventListener('abort', done, { once: true })
        void Promise.all(waiting).then(done)
    })
    // 合成这一轮的工具表：只含已连上的；名字加 `${name}_` 前缀，不同服务器的同名工具互不覆盖。
    const result: Record<string, Tool> = {}
    for (const [name, client] of clients) if (client.status === 'ready') for (const [toolName, tool] of Object.entries(client.tools)) result[`${name}_${toolName}`] = tool
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
