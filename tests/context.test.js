/*
盯住"发给模型的上下文长什么样"：裁剪、回合配对、压缩后怎么拼、总结放在哪。

Context 只读 history，从不修改它。这里所有测试都建立在同一条契约上：
裁剪只发生在"这一次交给模型的内容"上，history 本身永远完整。
*/

import { expect, test, describe } from 'bun:test'
import History from '../features/history.js'
import Context from '../features/context.js'
import { withTurns, pairing } from './helpers.js'

describe('Context 裁剪', () => {
    test('预算太紧时也不会只剩一条 system（模型拒收空消息）', () => {
        // 压缩会把总结追加到末尾；重建上下文时若"最初目标"和"最近现场"都装不下，
        // 旧实现会只剩 system，AI SDK 直接抛 InvalidPrompt（messages must not be empty）。
        const history = [
            History.user({ content: 'A'.repeat(45000) }),      // 最初目标太大，装不进 20% 预算。
            History.user({ content: 'B'.repeat(70000) }),      // 最近一条也太大，装不进 30% 预算。
            History.compact({ content: '总结' }),               // 紧接着就重建。
        ]
        const { messages } = Context.build({ history, budget: 128000, ratio: 0.6, system: 's' })
        const nonSystem = messages.filter(message => message.role !== 'system')
        expect(nonSystem.length).toBeGreaterThan(0)             // 至少留一条真实消息，请求才发得出去。
    })

    test('只发一张被 strip 掉的图时，也不会只剩 system', () => {
        // 回合留下了，但媒体被摘空、消息整条被 filter 掉，旧实现没在最终 messages 上兜底。
        const history = [History.user({ content: [{ type: 'image', image: 'x' }] })]
        const { messages } = Context.build({ history, system: 's', capabilities: { image: false }, mediaFallback: 'strip' })
        expect(messages.some(message => message.role !== 'system')).toBe(true)
    })

    test('历史里有缺 content 的消息时，裁剪不崩', () => {
        // agent.history 是公开可写的，也能从库里恢复；少一个 content 字段不该让整次 send 崩。
        const history = [
            History.user({ content: '开始' }),
            { id: 'x', role: 'assistant', content: undefined },
            History.compact({ content: '总结' }),
        ]
        expect(() => Context.build({ history, system: 's', budget: 10, ratio: 0.6 })).not.toThrow()
    })

    test('最初目标与最近现场拼起来也不打乱时间顺序', () => {
        const history = [
            History.user({ content: 'u0' }),
            History.assistant({ content: 'a1', toolCalls: [{ id: 'c1', name: 't', arguments: {} }] }),
            History.tool({ toolCallId: 'c1', toolName: 't', content: 'r1' }),
            History.user({ content: 'u2' }),
            History.assistant({ content: 'a3', toolCalls: [{ id: 'c3', name: 't', arguments: {} }] }),
            History.tool({ toolCallId: 'c3', toolName: 't', content: 'r3' }),
            History.compact({ content: '总结' }),
            History.user({ content: 'u6' }),
        ]
        const { messages } = Context.build({ history, system: 's', budget: 128000, ratio: 0.6 })
        const text = JSON.stringify(messages)
        expect(text.indexOf('u0')).toBeLessThan(text.indexOf('a1')) // 应答必须跟在它触发的用户消息之后。
        expect(text.indexOf('a1')).toBeLessThan(text.indexOf('u2')) // 顺序不能因为"目标/现场"分段而错乱。
    })

    test('只剩总结的历史不会把总结当 user 消息再发一遍', () => {
        const { messages } = Context.build({ history: [History.compact({ content: '总结内容XYZ' })] })
        expect(messages.some(message => message.role !== 'system')).toBe(true)                        // 仍要有可发的消息。
        const nonSystem = messages.filter(message => message.role !== 'system').map(message => JSON.stringify(message.content))
        expect(nonSystem.some(text => text.includes('总结内容XYZ'))).toBe(false)                       // 总结只折进 system，别当 user 消息重发。
    })

    test('压缩后不再切断 tool-call 与 tool-result 的配对', () => {
        const history = withTurns(5)
        history.push(History.compact({ content: '前面读了 5 个文件' }))
        history.push(History.user({ content: '继续' }))

        const { messages } = Context.build({ history, system: 'sys' })
        expect(pairing(messages)).toEqual({ ok: true })
        expect(messages.length).toBeLessThan(history.length + 1) // 确实裁掉了东西，不是靠"全都留下"蒙混过关。
    })

    test('一条 assistant 带多个并行 tool-call 时整个回合同进同出', () => {
        const history = [History.user({ content: '并行读三个文件' })]
        history.push(History.assistant({ content: null, toolCalls: [1, 2, 3].map(n => ({ id: `p-${n}`, name: 'read', arguments: { path: `f${n}` } })) }))
        for (const n of [1, 2, 3]) history.push(History.tool({ toolCallId: `p-${n}`, toolName: 'read', content: `内容${n}` }))
        history.push(History.compact({ content: '读完了三个文件' }))
        history.push(History.user({ content: '继续' }))

        expect(pairing(Context.build({ history }).messages)).toEqual({ ok: true })
    })

    test('连续多次压缩后依然配对完整', () => {
        const history = withTurns(3)
        history.push(History.compact({ content: '第一次总结' }))
        history.push(...withTurns(3).slice(1))
        history.push(History.compact({ content: '第二次总结' }))
        history.push(History.user({ content: '接着干' }))

        expect(pairing(Context.build({ history }).messages)).toEqual({ ok: true })
    })

    test('工具结果排在调用前面时也能认回自己的回合，不再被静默丢弃', () => {
        // 从数据库按 id 恢复会话、或多路并发写 history 时，结果排到调用前面是完全可能的。
        const call = History.assistant({ content: null, toolCalls: [{ id: 'c-1', name: 'read', arguments: { path: 'a' } }] })
        const result = History.tool({ toolCallId: 'c-1', toolName: 'read', content: '内容' })
        const history = [History.user({ content: '读一下' }), result, call] // 故意把结果放在调用前面。

        const { messages } = Context.build({ history })
        const parts = messages.flatMap(message => (Array.isArray(message.content) ? message.content : []))

        expect(parts.some(part => part.type === 'tool-result' && part.toolCallId === 'c-1')).toBe(true) // 一趟遍历的写法会在这里把结果丢掉。
        expect(pairing(messages)).toEqual({ ok: true })
    })

    test('没人应答的工具调用被摘掉，而不是带着它去撞 MissingToolResultsError', () => {
        const history = [
            History.user({ content: '读一下' }),
            History.assistant({ content: '这就去', toolCalls: [{ id: 'lost', name: 'read', arguments: { path: 'a' } }] }), // 工具没跑完进程就挂了。
        ]
        const { messages } = Context.build({ history })
        const parts = messages.flatMap(message => (Array.isArray(message.content) ? message.content : []))

        expect(parts.some(part => part.type === 'tool-call')).toBe(false)  // 带着它 AI SDK 在本地就抛，请求一个字节都发不出去。
        expect(parts.some(part => part.type === 'text')).toBe(true)        // 正文仍然保留。
    })

    test('content 是字符串或缺失的合法消息不会把 build 打崩', () => {
        // AI SDK 的 AssistantContent 定义就是 string | Array<...>，而 agent.history 是公开可写的，
        // 上层完全可能直接塞一条这样的消息进来。
        const history = [
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '你好呀' },
            { role: 'tool', content: [] },
        ]
        expect(() => Context.build({ history })).not.toThrow()
    })

    test('思考内容留在 history 但不发给模型', () => {
        const history = [
            History.user({ content: '你好' }),
            History.assistant({ content: [{ type: 'reasoning', text: '我先想一下' }, { type: 'text', text: '好的' }] }),
        ]
        const { messages } = Context.build({ history })
        const parts = messages.flatMap(message => (Array.isArray(message.content) ? message.content : []))

        expect(parts.some(part => part.type === 'reasoning')).toBe(false) // 回传思考会被 gpt-oss-120b 这类服务 400。
        expect(parts.some(part => part.type === 'text')).toBe(true)       // 正文还在。
        expect(history[1].content.some(part => part.type === 'reasoning')).toBe(true) // 原始历史没有被改动，上层 UI 仍能渲染思考。
    })

    test('只剩思考的 assistant 消息整条不发出去', () => {
        const history = [
            History.user({ content: '你好' }),
            History.assistant({ content: [{ type: 'reasoning', text: '纯思考，没有正文' }] }),
        ]
        expect(Context.build({ history }).messages.every(message => message.content.length)).toBe(true) // 空 content 的消息会被供应商拒绝。
    })

    test('没人读 token 时不做分词估算', () => {
        const context = Context.build({ history: withTurns(3) })

        // token 是取值器：没设 maxContextTokens 时 Loop 根本不读它，分词那一遍（2000 条历史约 120ms）就不会白跑。
        expect(typeof Object.getOwnPropertyDescriptor(context, 'token').get).toBe('function')
        expect(context.token).toBeGreaterThan(0)  // 读的时候仍然算得出来。
        expect(context.token).toBe(context.token) // 读第二次直接用缓存，不重复分词。
    })
})


describe('总结怎么进上下文', () => {
    test('总结折进 system 并说明身份，不再当成一条用户消息', () => {
        // 裸的 role:'user' 总结会被模型读成"用户塞给我一张表"，于是它从头重做整个任务。
        // 真实端点实测：gpt-oss-120b 改之前 1/6 能正确续跑，改之后 6/6。
        const history = [
            History.user({ content: '核对 12 个箱子' }),
            History.compact({ content: '已经核对完 C01 到 C06' }),
            History.user({ content: '继续' }),
        ]
        const { messages } = Context.build({ history, system: '你是助手' })

        expect(messages[0].role).toBe('system')
        expect(messages[0].content).toContain('你是助手')                 // 原来的系统提示词还在。
        expect(messages[0].content).toContain('你此前工作的压缩记录')       // 总结带着身份说明进了 system。
        expect(messages[0].content).toContain('已经核对完 C01 到 C06')
        expect(messages.slice(1).some(message => String(message.content).includes('已经核对完'))).toBe(false) // 对话里不再有裸的总结消息。
    })

    test('巨大的开场消息不会让压缩永远收敛不了', () => {
        // 用户第一条就粘一大段日志时，"最初目标"按条数被永久钉住，压缩压完仍然超限，
        // 于是每一轮都白压一次——实测 120/120 轮都没降到阈值以下。现在它要占预算，占不下就不留。
        const history = [History.user({ content: '日志'.repeat(7000) })]
        for (let i = 1; i <= 6; i += 1) history.push(History.user({ content: `第 ${i} 步` }))
        history.push(History.compact({ content: '短总结' }))
        history.push(History.user({ content: '继续' }))

        const budgeted = Context.build({ history, budget: 6000 }).token
        expect(budgeted).toBeLessThan(6000 * 0.8)                               // 压缩之后真的降到阈值以下了。
        expect(budgeted).toBeLessThan(Context.build({ history }).token)         // 不给预算时它会把那坨日志原样钉着。
    })

    test('总结之后的新回合不受预算限制', () => {
        // 总结后的内容是当前正在推进的工作，它涨起来是正常的，Loop 会在下一次超阈值时再压一次。
        const history = [History.user({ content: '开始' }), History.compact({ content: '总结' })]
        for (let i = 0; i < 8; i += 1) history.push(History.user({ content: `新消息 ${i}` }))

        const { messages } = Context.build({ history, budget: 10 })             // 预算小到几乎为零。
        expect(messages.filter(message => String(message.content).startsWith('新消息')).length).toBe(8)
    })

    test('一次 send 里连续压缩多次，本次的用户输入仍然在上下文里', () => {
        // 长跑压测发现的：一次 send 里压缩触发两次以上时，本次用户输入会落到最新总结之前。
        // 它既不在最初目标里（用户说得多了，超出 KEEP_FIRST），又装不进最近现场的预算（这条消息很大），
        // 于是被整条丢掉——模型收不到任务，只能瞎猜。这条消息是本次 send 的指令，任何预算下都必须留下。
        const history = [
            History.user({ content: '最初目标' }),
            History.compact({ content: '第一次总结' }),
            History.user({ content: `重要指令：${'Z'.repeat(5000)}` }),   // 本次的用户输入，大到装不进 20% / 30% 的任何一段预算。
            History.assistant({ content: null, toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] }),
            History.tool({ toolCallId: 'c1', toolName: 'read', content: '读到的内容' }),
            History.compact({ content: '第二次总结' }),                    // 同一个 send 里又压了一次，把用户输入压到总结之前。
        ]
        const { messages } = Context.build({ history, budget: 1000, ratio: 0.6 })

        expect(JSON.stringify(messages).includes('重要指令')).toBe(true)          // 本次任务必须还在。
        expect(pairing(messages)).toEqual({ ok: true })                          // 硬加回来后配对仍然完整。
    })
})
