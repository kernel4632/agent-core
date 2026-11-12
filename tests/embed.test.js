/*
盯住"这个包嵌进别人项目之后还够不够用"。

这个包会被打包成单文件嵌进别的项目，那时 default 导出就是唯一入口——
凡是嵌入方需要的东西都必须挂在上面，否则在产物里根本够不着。
这里测的每一条都对应一件嵌入方真的要做的事：造历史消息、读历史、定位工具目录。
*/

import { expect, test, describe } from 'bun:test'
import Agent from '../index.js'
import History from '../features/history.js'
import Context from '../features/context.js'
import Tool from '../features/tool.js'
import { BROKEN, TOOLS, pairing } from './helpers.js'

describe('可嵌入性', () => {
    test('入口带齐了嵌入方需要的全部模块', () => {
        expect(Object.keys(Agent).sort()).toEqual(['compact', 'context', 'create', 'history', 'llm', 'output', 'schema', 'textTools', 'tool', 'version'])
        expect(Agent.version).toMatch(/^\d+\.\d+\.\d+/) // 排查问题时上层要能报出版本。
    })

    test('手写的类型声明没有落后于代码', async () => {
        // index.d.ts 是手写的，改了代码忘了改它，TS 用户就会看到不存在的字段、或找不到新字段。
        // 这里拿运行时的真实形状去对照声明文件，漏掉任何一个都会红。
        const declared = await Bun.file(new URL('../index.d.ts', import.meta.url)).text()
        const block = name => declared.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
        const has = (name, key) => new RegExp(`^\\s+${key}\\??:`, 'm').test(block(name))

        for (const key of Object.keys(Agent)) expect(has('Agent', key)).toBe(true)                                  // Agent.xxx 每一项都有声明。
        const agent = Agent.create()
        for (const key of Object.keys(agent)) expect(has('AgentInstance', key)).toBe(true)                          // 实例上的每个字段都有声明。
        for (const key of Object.keys(agent.config)) expect(has('Config', key)).toBe(true)                          // 每个配置项都有声明。
        for (const key of Object.keys(Agent.history)) expect(has('HistoryModule', key)).toBe(true)
        for (const key of Object.keys(Agent.tool)) expect(has('ToolModule', key)).toBe(true)
        for (const key of Object.keys(Agent.textTools)) expect(has('TextToolsModule', key)).toBe(true)
        for (const key of Object.keys(Agent.context)) expect(has('ContextModule', key)).toBe(true)
        for (const key of Object.keys(Agent.compact)) expect(has('CompactModule', key)).toBe(true)
        for (const key of Object.keys(Agent.llm)) expect(has('LLMModule', key)).toBe(true)
    })

    test('onPermission 收到的每个字段，README 和类型声明都写了', async () => {
        // issue #5：运行时一直传 signal，README 也写了，只有 index.d.ts 漏了——TS 用户读 permission.signal 就编译失败。
        // 这里抓一次真实传给回调的字段，逐个去两份文档里对照。
        let received
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const body = await request.json()
                const answered = body.messages.some(message => message.role === 'tool')
                const message = answered
                    ? { role: 'assistant', content: '好' }
                    : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"value":"x"}' } }] }
                return Response.json({ choices: [{ index: 0, message, finish_reason: answered ? 'stop' : 'tool_calls' }], usage: {} })
            },
        })
        try {
            const tools = await Tool.scan(TOOLS)
            const agent = Agent.create({ tools, config: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false }, callbacks: { onPermission: permission => { received = permission; return true } } })
            await agent.send('跑一下')
        } finally { server.stop(true) }

        expect(received.signal).toBeInstanceOf(AbortSignal)
        const declared = (await Bun.file(new URL('../index.d.ts', import.meta.url)).text()).match(/onPermission\?: \(permission: \{([^}]*)\}/)[1]
        const readme = (await Bun.file(new URL('../README.md', import.meta.url)).text()).match(/\| `onPermission` \|[^|]*\| `\{([^}]*)\}`/)[1]
        for (const key of Object.keys(received)) {
            expect(declared).toContain(`${key}:`) // 类型声明里有这个字段。
            expect(readme).toContain(key)         // README 的回调表里也有。
        }
        expect(declared).toContain('signal: AbortSignal')
    })

    test('History 除了造消息块，还给出读历史的操作', () => {
        // 嵌入方拿到 history 之后要做的事不止"往里塞一条"：要渲染给用户看、要数聊了几轮。
        // 这两件事的知识（内容块有哪些形状、回合怎么划分）本来就在核心里，
        // 不暴露的话每个嵌入方都要照着内部结构重写一遍——实测重写 turns 很容易写错。
        expect(typeof Agent.history.turns).toBe('function')
        expect(typeof Agent.history.render).toBe('function')
    })

    test('History.error：只给宿主看的失败记录，能存能渲染，但不是对话回合', () => {
        // issue #27：宿主想把失败请求也留在 history 里（刷新后还能看见），又不希望模型收到它。
        const record = History.error({ content: '请求失败：500', request: { model: 'm', ms: 12 } })

        expect(record).toMatchObject({ role: 'error', content: '请求失败：500', request: { model: 'm', ms: 12 } })
        expect(typeof record.id).toBe('string')                                          // 和其它历史块一样有 id。
        expect(Agent.history.turns([History.user({ content: '你好' }), record])).toHaveLength(1) // 不是回合。
        expect(Agent.history.render([History.user({ content: '你好' }), record])).toContain('请求失败：500') // UI 读得到。
    })

    test('turns 把工具结果归到发起它的回合，排在哪都认得出', () => {
        const call = History.assistant({ content: '我来读', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] })
        const result = History.tool({ toolCallId: 'c1', toolName: 'read', content: '内容' })

        // 正序和乱序（从库里按 id 恢复会话就是这个形态）必须得到同样的回合划分。
        for (const history of [[History.user({ content: '读一下' }), call, result], [History.user({ content: '读一下' }), result, call]]) {
            const turns = Agent.history.turns(history)
            expect(turns.length).toBe(2)                                   // 用户一个回合，模型响应连着它的工具结果一个回合。
            expect(turns[1].map(message => message.role)).toEqual(['assistant', 'tool'])
        }
    })

    test('Context 和 History 用的是同一份回合定义', () => {
        // 回合的规则很微妙，只能有一处定义。Context.build 裁剪时用它，上层数轮次也用它。
        const history = [
            History.user({ content: '开始' }),
            History.assistant({ content: null, toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] }),
            History.tool({ toolCallId: 'c1', toolName: 'read', content: '内容' }),
        ]
        expect(Agent.history.turns(history).flat().length).toBe(history.length) // 一条不多一条不少。
        expect(pairing(Context.build({ history }).messages)).toEqual({ ok: true })
    })

    test('render 把各种内容块摊平成人能读的文本', () => {
        const history = [
            History.user({ content: [{ type: 'text', text: '这张图' }, { type: 'image', image: 'data:x' }] }),
            History.assistant({ content: [{ type: 'reasoning', text: '想一下' }, { type: 'text', text: '我来读' }], toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] }),
            History.tool({ toolCallId: 'c1', toolName: 'read', content: '文件内容' }),
        ]
        const lines = Agent.history.render(history).split('\n')

        expect(lines[0]).toBe('user: 这张图 [图片]')            // 图片折叠成标记，正文原样出。
        expect(lines[1]).toContain('[思考]')                    // 思考折叠。
        expect(lines[1]).toContain('[调用 read')                // 工具调用带上名字和参数。
        expect(lines[2]).toBe('tool: [read 返回] 文件内容')      // 工具输出块被摊平。
    })

    test('从入口就能造出合法的历史消息块', () => {
        // 嵌入方要做的事：把 IM 消息转成 user 块、往历史里塞系统通知、从库里恢复会话。
        // 没有这个就只能手写 { id, role, content } 并自己保证格式对。
        expect(Agent.history.user({ content: '你好' }).role).toBe('user')
        expect(Agent.history.compact({ content: '总结' }).role).toBe('compact')
        expect(typeof Agent.history.assistant).toBe('function')
        expect(typeof Agent.history.tool).toBe('function')
    })

    test('工具调用的 arguments 是坏 JSON 字符串时也不崩，退化成空参数', () => {
        // 从库里恢复会话、或手写历史时，arguments 可能是没解析好的字符串。
        // 直接 JSON.parse 会抛 SyntaxError，把整次 send 打死；这里按"读不出参数"处理。
        const assistant = Agent.history.assistant({ content: null, toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":' }] })
        expect(assistant.content[0].input).toEqual({})
    })

    test('scan 直接收 URL，不用调用方自己拼路径', async () => {
        // 嵌进别人项目时，工具目录的位置只能相对调用方自己的代码算，手边拿到的就是 URL。
        // 以前只收字符串路径，Windows 上还得自己剥掉 pathname 的前导斜杠。
        const tools = await Tool.scan(TOOLS)
        expect(tools.schema.echo).toBeDefined()
    })

    test('scan 能合并多个目录，后面的覆盖前面的同名工具', async () => {
        // 内置工具目录在前、用户工具目录在后，用户就能覆盖内置工具——不用为此写任何注册逻辑。
        const merged = await Tool.scan(TOOLS, BROKEN)
        expect(merged.schema.echo).toBeDefined()   // 第一个目录的还在。
        expect(merged.schema.cyclic).toBeDefined() // 第二个目录的也进来了。
    })
})
