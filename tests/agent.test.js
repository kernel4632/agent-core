/*
盯住 Agent 这个最外层入口本身：怎么造、怎么喂输入、参数怎么合并。

这里不测主循环怎么跑（那是 loop.test.js 的事），只测"调用者写下的东西有没有被正确接住"。
调用体验的每一条抱怨最后都落在这个文件里：少写一个对象字面量、少传一层 config、
不该被共享的对象被共享了。
*/

import { expect, test, describe, afterAll } from 'bun:test'
import Agent from '../index.js'
import History from '../features/history.js'

const recorded = []
const server = Bun.serve({
    port: 0,
    async fetch(request) {
        recorded.push(await request.json())
        return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }], usage: {} })
    },
})
const config = extra => ({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false, ...extra })

afterAll(() => server.stop(true))


describe('Agent 入口', () => {
    test('拿到的对象就是 Agent 公开的内部状态', () => {
        const history = []
        const first = Agent.create({ history })
        const second = Agent.create()

        expect(first.history).toBe(history)     // 直接保存外部传入的数组，外部和 Agent 共同修改它。
        expect(second.history).toEqual([])      // 不传就是各自新建的，两台 Agent 不共享。
        expect(first.config.protocol).toBe('chat')
        expect(first.config.capabilities).toMatchObject({ image: true, audio: true, video: true, file: true, usage: true }) // 媒体默认值来自 History.mediaDefaults，不能漏。
        expect(first.config.maxSteps).toBeUndefined() // 默认不限制 Agent 运行轮数，是否限制由调用方决定。
        expect(first.running).toBeNull()
    })

    test('create 收到坏的 config/history/callbacks 当场报错，不拖到 send', () => {
        expect(() => Agent.create({ config: null })).toThrow(/config/)
        expect(() => Agent.create({ history: 'x' })).toThrow(/history/)
        expect(() => Agent.create({ callbacks: 1 })).toThrow(/callbacks/)
    })

    test('send 收到畸形的用户内容块时当场拒绝，不写进 history', async () => {
        const agent = Agent.create()
        const error = await agent.send([{ type: 'image', image: 123 }]).catch(caught => caught)
        expect(error).toBeInstanceOf(TypeError)
        expect(agent.history.length).toBe(0) // 坏块没进只增不删的历史。
    })

    test('config 里的 provider 是浅拷一层，两个 Agent 不共享同一个对象', () => {
        const shared = { temperature: 0.2 }
        const first = Agent.create({ config: { provider: shared } })
        const second = Agent.create({ config: { provider: shared } })

        expect(first.config.provider).not.toBe(shared)   // 改一台的 provider 不该动到另一台或调用方手里那个。
        expect(first.config.provider).toEqual({ temperature: 0.2 })
        expect(second.config.provider).toEqual({ temperature: 0.2 })
    })

    test('send 替换 provider 后不会持有调用方的对象', async () => {
        const agent = Agent.create({ config: config() })
        const provider = { temperature: 0.2 }
        await agent.send({ input: '你好', config: { provider } })
        provider.temperature = 0.9
        expect(agent.config.provider.temperature).toBe(0.2)
    })

    test('send 直接收一句话，不用包成对象', async () => {
        // 最常用的调用形态。逼调用者写 send({ input: '你好' }) 是把内部结构漏出来。
        recorded.length = 0
        const agent = Agent.create({ config: config() })
        await agent.send('你好')

        expect(agent.history[0].content).toBe('你好')
        expect(recorded[0].messages.at(-1).content).toBe('你好') // 第一次请求就该带上这句话。
    })

    test('send 收内容块数组（发图片走这条路）', async () => {
        const shot = [{ type: 'text', text: '这张图' }, { type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' }]
        const agent = Agent.create({ config: config() })
        await agent.send(shot)

        expect(agent.history[0].content).toEqual(shot)
    })

    test('send 的完整形式仍然可用，参数照常生效', async () => {
        const agent = Agent.create({ config: config() })
        await agent.send({ input: '完整形式', config: { provider: { temperature: 0.4 } } })

        expect(agent.history[0].content).toBe('完整形式')
        expect(recorded.at(-1).temperature).toBe(0.4)
    })

    test('空输入当场拒绝，而不是发出一轮空请求', async () => {
        const agent = Agent.create({ config: config() })

        // 出错方式只有一种：返回的 Promise 拒绝。调用方不需要额外写同步的 try/catch。
        await expect(agent.send('')).rejects.toThrow('input must be')
        await expect(agent.send('   ')).rejects.toThrow('input must be')  // 只有空白也算空。
        await expect(agent.send([])).rejects.toThrow('input must be')
        await expect(agent.send({})).rejects.toThrow('input must be')     // 完整形式漏了 input 也一样。
        expect(agent.history.length).toBe(0)                              // 被拒绝的输入不写进历史。
    })

    test('非法配置和非法 signal 也走 Promise 拒绝，不抛出同步异常', async () => {
        // README 承诺"出错只有 Promise 拒绝一种"，所以这两种最常见的误用在调用现场也不该炸。
        const agent = Agent.create({ config: config() })

        // 调用那一刻不能抛同步异常：返回的必须是 Promise（下面再等它拒绝）。
        const badConfig = agent.send({ input: 'x', config: null })
        const badSignal = agent.send('x', { signal: {} })
        expect(badConfig).toBeInstanceOf(Promise)
        expect(badSignal).toBeInstanceOf(Promise)
        await expect(badConfig).rejects.toThrow('config must be an object')
        await expect(badSignal).rejects.toThrow('signal must be an AbortSignal')
        await expect(agent.send({ input: 'x', config: { maxToolConcurrency: 0 } })).rejects.toThrow('maxToolConcurrency')
        await expect(agent.send({ input: 'x', config: { noToolRounds: 0 } })).rejects.toThrow('noToolRounds')
        await expect(agent.send({ input: 'x', config: { compactThreshold: undefined } })).rejects.toThrow('compactThreshold') // undefined 会让压缩永远不触发。
        await expect(agent.send({ input: 'x', config: { compactThreshold: 0 } })).rejects.toThrow('compactThreshold')       // 0 会让每轮都触发。
        await expect(agent.send({ input: 'x', config: { maxContextTokens: '1000' } })).rejects.toThrow('maxContextTokens')       // 字符串会让压缩算不出来。
    })

    test('maxToolConcurrency 设成 Infinity 是合法的', async () => {
        const agent = Agent.create({ config: config({ maxToolConcurrency: Infinity }) })
        await agent.send('不限并发')
        expect(agent.config.maxToolConcurrency).toBe(Infinity)
    })

    test('send 被后来的指令顶掉时，它的 history/config 覆盖不会留下', async () => {
        // 同一个 tick 里 B 带着覆盖项发出，还没开跑就被 C 顶掉。B 是一次已取消的指令，
        // 不该改掉这台 Agent 的历史和配置——否则 C 会跑在 B 留下的状态上。
        const agent = Agent.create({ config: config() })
        const other = [History.user({ content: '另一份历史' })]

        const a = agent.send('任务A').catch(() => {})
        const b = agent.send({ input: '任务B', history: other, config: { provider: { temperature: 0.99 } } }).catch(() => {})
        const c = agent.send('任务C')

        await Promise.allSettled([a, b, c])
        expect(agent.history).not.toBe(other)                          // B 的 history 覆盖没生效。
        expect(agent.config.provider.temperature).toBeUndefined()      // B 的 provider 覆盖没生效。
        expect(agent.history.some(message => message.content === '任务B')).toBe(false) // B 的输入也没写进去。
    })

    test('send 之后 config 按字段合并，没传的字段继续保留', async () => {
        const agent = Agent.create({ config: config({ maxToolOutput: 1000, provider: { temperature: 0.1 } }) })
        await agent.send({ input: '第一次', config: { maxToolOutput: 2000 } })

        expect(agent.config.maxToolOutput).toBe(2000)   // 这次改的。
        expect(agent.config.provider.temperature).toBe(0.1) // 没提的继续留着。
        expect(agent.config.maxContextTokens).toBe(128000) // 默认带上上下文预算，自动压缩才会开启。
    })

    test('send 传的 compact 只覆盖写了的字段，其余保留', async () => {
        const agent = Agent.create({ config: config({ compact: { baseURL: 'http://a', apiKey: 'ka', model: 'cheap' } }) })
        await agent.send({ input: 'x', config: { compact: { model: 'cheaper' } } })
        expect(agent.config.compact).toEqual({ baseURL: 'http://a', apiKey: 'ka', model: 'cheaper' }) // 局部覆盖不丢字段。
    })

    test('外部 signal 已取消时 send 拒绝，错误带 kind', async () => {
        const agent = Agent.create({ config: config() })
        const controller = new AbortController()
        controller.abort()
        const error = await agent.send('x', { signal: controller.signal }).catch(caught => caught)
        expect(error.kind).toBe('aborted') // 取消错误和模型错误一样能用 error.kind 分支。
    })

    test('历史是外部传进来的那份数组，Agent 往里追加而不是替换', async () => {
        const history = [History.user({ content: '上一轮' })]
        const agent = Agent.create({ history, config: config() })
        await agent.send('这一轮')

        // 只数用户说的话：助手消息和临时提示也写进历史，它们的条数不是这条测试要盯的东西。
        const said = history.filter(message => message.role === 'user').map(message => message.content)
        expect(agent.history).toBe(history) // 引用没换过。
        expect(said).toEqual(['上一轮', '这一轮'])
    })

    test('send 支持按次替换整份历史', async () => {
        const agent = Agent.create({ config: config() })
        await agent.send('第一条')
        const replaced = [History.user({ content: '换一份历史' })]
        await agent.send({ input: '第二条', history: replaced })

        expect(agent.history).toBe(replaced)
    })
})
