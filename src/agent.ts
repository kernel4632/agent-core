/*
Agent：唯一的状态持有者。宿主能直接读写的状态都是实例上的公开字段，改完下一轮生效，不需要调任何"通知"方法。

调用示例：
    const agent = Agent.create({ model: 'gpt-4o', baseURL, apiKey, system: '你是一个助手。', tools: ['/plugins/a/tool.ts', '/plugins/b/'] })
    const { reason, text, usage, output } = await agent.send('帮我做件事', { onChunk: c => render(c) })
    agent.tools = agent.tools.filter(p => !p.startsWith('/plugins/a/'))   // 关掉插件 a：下一次请求就没有它的工具
    agent.config = { ...agent.config, model: 'claude-sonnet-4' }          // 中途换模型：下一轮生效
    await agent.stop()                                                    // 立即杀掉本实例的工具子进程
    await agent.compact()                                                 // 宿主点"压缩"：强制压缩一次
    const reply = await Agent.LLM.ask({ model, baseURL, apiKey, messages })  // 不建实例也能直接问模型

公开状态（宿主直接读写）：config、history、tools、mcp、contextRatio、ratios，以及 id。
私有状态（#internal，不对外）：工具元数据缓存、MCP 连接、正在跑的子进程 procs、当前运行的取消器、警告去重。
每个实例完全隔离，不共享任何可变状态。

导入：loop/run（run、compact）、tools/spawn（killAll）、history（append）、model/ask（挂到 Agent.LLM）。
*/

import { nanoid } from 'nanoid'
import type { Answer, Callbacks, Config, CreateOptions, Input, Internal, McpServer, Message, State } from './types.ts'
import { run, compact } from './loop/run.ts'
import { killAll } from './tools/spawn.ts'
import { append } from './history.ts'
import { ask } from './model/ask.ts'

export class Agent {
    // 问模型的公开封装：Agent.LLM.ask(request, onChunk)，独立于任何实例。
    static readonly LLM = { ask }

    id: string                          // 会话 id，onPermission 等回调里带给宿主
    config: Config                      // 活配置：每轮现读
    history: Message[]                  // 只增不减；宿主可直接读写，核心只原地追加
    tools: string[]                     // 工具文件 / 目录路径；增删下一轮生效
    mcp: McpServer[]                    // MCP 连接配置；增删下一轮生效
    contextRatio: number | undefined    // 冷启动估算比例（宿主持久化的值）；没学到真实值之前用它
    ratios: Record<string, number>      // 学到的比例 { 模型名: 比例 }，跨服务商共用；宿主可持久化
    #internal: Internal                 // 私有：缓存、连接、子进程、当前运行

    /*
    构造函数不对外推荐使用，统一走 Agent.create（保持和旧 API 一致的工厂写法）。
    只做字段赋值和入口校验（config 必须有 model、history 必须是数组、tools / mcp 必须是数组），不做任何 I/O。
    */
    constructor(options: CreateOptions) {
        throw new Error('TODO')
    }

    /*
    create：同步创建一个独立实例。参数平铺：配置字段直接写在顶层，另带 id、history、tools、mcp、contextRatio、ratios。
    工具不在这里读取——每轮请求前由 loop 现读，所以 create 不需要 async。
    */
    static create(options: CreateOptions): Agent {
        throw new Error('TODO')
    }

    /*
    send：有输入就先 append 进 history（没有输入 = 从当前历史继续），然后交给 loop.run 跑到结束。
    同一实例一次只跑一件事：如果上一次 send / compact 还在跑，先 stop 它并等它收尾，再开始这一次，
    避免两条循环同时写同一份 history。不接受外部 signal，停止统一走 stop()。
    */
    async send(input?: Input, callbacks: Callbacks = {}): Promise<Answer> {
        throw new Error('TODO')
    }

    /*
    stop：立即停止当前运行。abort 当前取消器（中断模型请求和 MCP 调用），并 killAll 本实例的子进程
    （不给工具任何反应时间）；等 loop 补完"已取消"结果后返回。没有运行时什么也不做。
    */
    async stop(): Promise<void> {
        throw new Error('TODO')
    }

    /*
    compact：宿主点"压缩"——强制压缩一次，只委托给 loop.compact，返回总结文字。
    和 send 一样受"一次只跑一件事"约束，可以被 stop() 打断。
    */
    async compact(callbacks: Callbacks = {}): Promise<string> {
        throw new Error('TODO')
    }

    /*
    #state：给 loop 的状态视图。公开字段用 getter 指回实例，宿主整份替换 agent.config / agent.tools 后
    loop 下一次读取就拿到新值；contextRatio 可写（宿主和 loop 都可能改）；internal 是私有部分。
    */
    #state(): State {
        throw new Error('TODO')
    }
}
