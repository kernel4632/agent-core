/*
Agent：唯一的状态持有者。宿主能直接读写的状态都是实例上的公开字段，改完下一轮生效，不需要调任何"通知"方法。

调用示例：
    const agent = Agent.create({ model: 'gpt-4o', baseURL, apiKey, system: '你是一个助手。', tools: ['/plugins/a/tool.ts', '/plugins/b/'] })
    const { reason, text, usage, output } = await agent.send('帮我做件事', { onChunk: c => render(c) })
    agent.tools = agent.tools.filter(p => !p.startsWith('/plugins/a/'))   // 关掉插件 a：下一次请求就没有它的工具
    agent.config = { ...agent.config, model: 'claude-sonnet-4' }          // 中途换模型：下一轮生效
    const { stopped, killed } = await agent.stop()                         // 立即杀掉本实例的工具子进程，等它们退出、循环收尾后才返回
    await agent.closeMcp('github')                                        // 临时关闭一条 MCP：立即断开，enabled 置 false，下一轮没有它的工具
    agent.openMcp('github')                                               // 重新打开：enabled 置 true，下一轮重连
    await agent.compact()                                                 // 宿主点"压缩"：强制压缩一次
    const reply = await Agent.LLM.ask({ model, baseURL, apiKey, messages })  // 不建实例也能直接问模型

公开状态（宿主直接读写）：config、history、tools、mcp、contextRatio、ratios，以及 id。
私有状态（#internal，不对外）：工具元数据缓存、MCP 连接、正在跑的子进程 procs、当前运行的取消器、警告去重。
每个实例完全隔离，不共享任何可变状态。

导入：loop/run（run、compact）、tools/spawn（killAll）、tools/mcp（close）、history（append）、model/ask（挂到 Agent.LLM）。
*/

import { nanoid } from 'nanoid'
import type { Answer, Callbacks, Config, CreateOptions, Input, Internal, McpServer, McpToggle, Message, State, Stopped } from './types.ts'
import { run, compact } from './loop/run.ts'
import { killAll } from './tools/spawn.ts'
import { close } from './tools/mcp.ts'
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
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Agent.create options must be an object')
        const { id = nanoid(), history = [], tools = [], mcp = [], contextRatio, ratios = {}, ...config } = options
        // 边界检查：坏值当场说清楚。history 只增不删，一个坏值写进去会永久毒化会话，所以宁可在入口报错。
        if (!config.model) throw new TypeError('model is required: a model name (with baseURL) or an AI SDK model instance')
        if (!Array.isArray(history)) throw new TypeError('history must be an array')
        if (!Array.isArray(tools)) throw new TypeError('tools must be an array of tool file / directory paths')
        if (!Array.isArray(mcp)) throw new TypeError('mcp must be an array of { name, url, headers?, transport? }')
        if (contextRatio !== undefined && !(typeof contextRatio === 'number' && Number.isFinite(contextRatio) && contextRatio > 0)) throw new RangeError('contextRatio must be a positive number')
        this.id = id
        this.config = config
        this.history = history                                           // 不复制：宿主传进来的数组就是 agent.history。
        this.tools = tools
        this.mcp = mcp
        this.contextRatio = contextRatio
        this.ratios = ratios
        this.#internal = { procs: new Set(), toolCache: new Map(), mcpClients: new Map(), controller: null, running: null, warned: new Set() }
    }

    /*
    create：同步创建一个独立实例。参数平铺：配置字段直接写在顶层，另带 id、history、tools、mcp、contextRatio、ratios。
    工具不在这里读取——每轮请求前由 loop 现读，所以 create 不需要 async。
    */
    static create(options: CreateOptions): Agent {
        return new Agent(options)
    }

    /*
    send：有输入就先 append 进 history（没有输入 = 从当前历史继续），然后交给 loop.run 跑到结束。
    同一实例一次只跑一件事：如果上一次 send / compact 还在跑，先 stop 它并等它收尾，再开始这一次，
    避免两条循环同时写同一份 history。不接受外部 signal，停止统一走 stop()。
    */
    async send(input?: Input, callbacks: Callbacks = {}): Promise<Answer> {
        // 先查输入再动任何状态：注定失败的调用不该把还在跑的上一次挤掉。
        if (input !== undefined && (typeof input === 'string' ? !input.trim() : !Array.isArray(input) || !input.length)) throw new TypeError('input must be a non-empty string or a non-empty content array')
        return this.#start(() => {
            if (input !== undefined) append(this.history, { role: 'user', content: input })
            return run(this.#state(), callbacks)
        })
    }

    /*
    stop：立即停止当前运行，返回 { stopped: true, wasRunning, killed }。
    abort 当前取消器（中断模型请求和 MCP 调用），killAll 本实例的子进程（不给工具任何反应时间）；
    只有在子进程全部确认退出、loop 补完"已取消"结果并退出之后才兑现——拿到返回值就说明已经停干净了。
    循环收尾后再清一次子进程：防止 abort 生效前恰好又起了一个（例如正在读工具元数据）。没有运行时直接返回。
    */
    async stop(): Promise<Stopped> {
        const { controller, running, procs } = this.#internal
        controller?.abort()                                              // 中断模型请求、MCP 调用、权限等待。
        let killed = await killAll(procs)                                // 立刻杀掉本实例的工具子进程，并等它们退出。
        await running?.catch(() => {})                                   // 等 loop 补完"已取消"结果，history 完整后再返回。
        killed += await killAll(procs)
        return { stopped: true, wasRunning: running !== null, killed }
    }

    /*
    closeMcp：临时关闭一条 MCP 连接。把 agent.mcp 里同名元素换成 enabled: false 的新对象（原地替换元素，
    不改宿主传进来的对象，也不换掉数组本身），并立即断开连接；下一轮请求起它的工具就不在了。
    正在执行中的该服务器工具调用会以错误结果结束。返回 { name, found, enabled: false, closed }。
    */
    async closeMcp(name: string): Promise<McpToggle> {
        const index = this.mcp.findIndex(server => server.name === name)
        if (index >= 0) this.mcp[index] = { ...this.mcp[index]!, enabled: false }
        const closed = await close(name, this.#internal.mcpClients)
        return { name, found: index >= 0, enabled: false, closed }
    }

    /*
    openMcp：重新打开 closeMcp 关掉的连接——只把 enabled 改回 true，下一轮请求时才真正连接
    （与"宿主改状态、下一轮生效"一致；连不上同样走 onWarning）。返回 { name, found, enabled }。
    */
    openMcp(name: string): McpToggle {
        const index = this.mcp.findIndex(server => server.name === name)
        if (index >= 0) this.mcp[index] = { ...this.mcp[index]!, enabled: true }
        return { name, found: index >= 0, enabled: index >= 0 }
    }

    /*
    compact：宿主点"压缩"——强制压缩一次，只委托给 loop.compact，返回总结文字。
    和 send 一样受"一次只跑一件事"约束，可以被 stop() 打断。
    */
    async compact(callbacks: Callbacks = {}): Promise<string> {
        return this.#start(async () => (await compact(this.#state(), callbacks, 'manual')).summary)
    }

    /*
    #start：同一实例一次只跑一件事。上一次还在跑就先停掉它并等它收尾（避免两条循环同时写 history），
    再换上新的取消器开始这一次；结束时只清理自己这一次的记录（防止清掉后来居上的新运行）。
    */
    async #start<T>(work: () => Promise<T>): Promise<T> {
        const internal = this.#internal
        const previous = internal.running
        const task = (async () => {
            if (previous) { internal.controller?.abort(); await killAll(internal.procs); await previous.catch(() => {}) }
            internal.controller = new AbortController()                  // loop 在开始时取一次这个信号。
            return work()
        })()
        internal.running = task
        try { return await task } finally {
            if (internal.running === task) { internal.running = null; internal.controller = null }
        }
    }

    /*
    #state：给 loop 的状态视图。公开字段用 getter 指回实例，宿主整份替换 agent.config / agent.tools 后
    loop 下一次读取就拿到新值；contextRatio 可写（宿主和 loop 都可能改）；internal 是私有部分。
    */
    #state(): State {
        const agent = this
        return {
            get id() { return agent.id },
            get config() { return agent.config },
            get history() { return agent.history },
            get tools() { return agent.tools },
            get mcp() { return agent.mcp },
            get contextRatio() { return agent.contextRatio },
            set contextRatio(value) { agent.contextRatio = value },
            get ratios() { return agent.ratios },
            internal: agent.#internal,
        }
    }
}
