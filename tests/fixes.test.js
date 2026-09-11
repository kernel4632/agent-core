/*
这一份专门盯住已经修掉的缺陷，每个 test 对应一个真实踩过的坑。
跑法和其它测试一样：bun test

每条测试的命名都是"它当初错在哪"，所以一旦有人改回旧写法，失败信息本身就说明了原因。
*/

import { expect, test, describe } from 'bun:test'
import Agent from '../index.js'
import History from '../utils/history.js'
import Context from '../features/context.js'
import Tool from '../features/tool.js'
import LLM from '../utils/llm.js'
import Loop from '../features/loop.js'

const BROKEN = new URL('./fixtures/broken', import.meta.url).pathname.replace(/^\//, '')               // Windows 下 pathname 会带前导斜杠。
const CYCLIC_FORMAT = new URL('./fixtures/cyclicformat', import.meta.url).pathname.replace(/^\//, '')  // 单独放一个目录，免得污染其它用例的工具表。

// --- 造一段真实形态的历史：用户指令 + 若干轮工具调用 + 压缩总结 ---
const withTurns = rounds => {
    const history = [History.user({ content: '帮我重构项目' })]
    for (let i = 1; i <= rounds; i += 1) {
        history.push(History.assistant({ content: null, toolCalls: [{ id: `call-${i}`, name: 'read', arguments: { path: `f${i}` } }] }))
        history.push(History.tool({ toolCallId: `call-${i}`, toolName: 'read', content: `文件${i}的内容` }))
    }
    return history
}

// 每条 tool 消息都必须能在它前面找到发起它的 tool-call，反之亦然。
// 供应商就是按这条规则校验的，配不上就是 400。
const pairing = messages => {
    const called = new Set()
    const answered = new Set()
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue
        for (const part of message.content) {
            if (part.type === 'tool-call') called.add(part.toolCallId)
            if (part.type === 'tool-result') {
                if (!called.has(part.toolCallId)) return { ok: false, why: `孤儿工具结果 ${part.toolCallId}` } // 没人发起过它。
                answered.add(part.toolCallId)
            }
        }
    }
    const missing = [...called].find(id => !answered.has(id))
    return missing ? { ok: false, why: `工具调用 ${missing} 没有结果` } : { ok: true }
}


describe('Context 裁剪', () => {
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

        // token 是取值器：没设 maxTokens 时 Loop 根本不读它，分词那一遍（2000 条历史约 120ms）就不会白跑。
        expect(typeof Object.getOwnPropertyDescriptor(context, 'token').get).toBe('function')
        expect(context.token).toBeGreaterThan(0)  // 读的时候仍然算得出来。
        expect(context.token).toBe(context.token) // 读第二次直接用缓存，不重复分词。
    })
})


describe('Tool 扫描', () => {
    test('工具目录里的非工具文件被跳过，不再让整次扫描崩溃', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools') // 这个目录里放着没有默认导出的 helper.js。
        expect(Object.keys(tools.schema).sort()).toEqual(['echo', 'noschema', 'partialschema', 'stream'])
    })

    test('没写 inputSchema 的工具也拿到合法的对象 Schema', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools')
        expect(tools.schema.noschema.inputSchema.jsonSchema).toEqual({ type: 'object', properties: {} }) // 缺了它 Anthropic 和 OpenAI 都会 400。
    })

    test('只写了 properties 没写 type 的工具，参数不会被吞掉', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools')
        expect(tools.schema.partialschema.inputSchema.jsonSchema).toEqual({
            type: 'object',                                          // 缺的 type 补上，
            properties: { path: { type: 'string' } },                // 工具自己写的 properties 一个不丢。
            required: ['path'],
        })
    })

    test('工具按名字定位，文件里排第几完全不影响', async () => {
        const tools = await Tool.scan(BROKEN) // order-a.js 里 second 排在 first 前面。
        const first = await Tool.execute({ name: 'first', input: {}, handlers: tools.handlers })
        const second = await Tool.execute({ name: 'second', input: {}, handlers: tools.handlers })

        expect(first.output.value).toBe('I-am-first')   // 按下标定位时这里会拿到 I-am-second。
        expect(second.output.value).toBe('I-am-second')
    })

    test('handlers 里不再保存下标', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools')
        expect(tools.handlers.echo).toEqual({ url: tools.handlers.echo.url })
    })
})


describe('Tool 执行', () => {
    test('工具返回循环引用时变成一条工具错误，而不是毒死 history', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'cyclic', input: {}, handlers: tools.handlers })

        expect(result.error).toBeTruthy()
        expect(result.output.type).toBe('error-text')
        expect(() => JSON.stringify(result.output)).not.toThrow() // 写进 history 之后 Context.build 还得能序列化它。
    })

    test('Date / Map / NaN 被规整成纯 JSON 再跨进程', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'rich', input: {}, handlers: tools.handlers })

        expect(result.output.value.when).toBe('2020-01-02T03:04:05.000Z') // Date 变字符串。
        expect(result.output.value.map).toEqual({})                       // Map 没有 JSON 表示。
        expect(result.output.value.bad).toBeNull()                        // NaN 变 null，AI SDK 才收。
    })

    test('带方法的类实例不再让成功的工具被报成失败', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'uncloneable', input: {}, handlers: tools.handlers })

        expect(result.error).toBeUndefined()        // 以前这里是 DataCloneError，模型会以为工具失败而重试。
        expect(result.output.value).toEqual({ value: 42 })
    })

    test('toModelOutput 抛错时这次调用仍然会结算', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'badformat', input: {}, handlers: tools.handlers }) // 以前这里永远挂着，整台 Agent 卡死。

        expect(result.error).toBeTruthy()
        expect(result.output.type).toBe('error-text')
    })

    test('工具把沙箱进程杀掉时这次调用仍然会结算', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'suicide', input: {}, handlers: tools.handlers }) // 以前只触发 close 事件，没人监听。

        expect(result.error).toBeTruthy()
        expect(result.output.value).toContain('沙箱')
    })

    test('沙箱被杀之后还能继续执行工具', async () => {
        const tools = await Tool.scan(BROKEN)
        await Tool.execute({ name: 'suicide', input: {}, handlers: tools.handlers })
        const after = await Tool.execute({ name: 'first', input: {}, handlers: tools.handlers })

        expect(after.output.value).toBe('I-am-first') // 沙箱塌了会自动重建，不需要调用方做任何事。
    })

    test('取消信号能瞬间杀掉死循环工具', async () => {
        const tools = await Tool.scan(BROKEN)
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 100)

        const started = Date.now()
        const result = await Tool.execute({ name: 'forever', input: {}, handlers: tools.handlers, signal: controller.signal })

        expect(result.interrupted).toBe(true)
        expect(Date.now() - started).toBeLessThan(2000) // 进程内的 await 永远做不到这件事，所以工具必须跑在 Worker 里。
    })

    test('同一套工具复用一个沙箱，不再按次新建 Worker', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools')
        const before = process.memoryUsage.rss()
        for (let i = 0; i < 40; i += 1) await Tool.execute({ name: 'echo', input: { value: String(i) }, handlers: tools.handlers })
        const grew = (process.memoryUsage.rss() - before) / 1048576

        expect(grew).toBeLessThan(200) // 按次新建时每个 Worker 留下约 22MB，40 次就是 800MB 以上。
    })

    test('signal 进来之前就已经取消时，这次调用立刻结算而不是永远挂着', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools')
        const controller = new AbortController()
        controller.abort() // 先取消，再调用——agent.stop() 之后残留的工具调用就是这个形状。

        const result = await Promise.race([
            Tool.execute({ name: 'echo', input: { value: 'x' }, handlers: tools.handlers, signal: controller.signal }),
            Bun.sleep(2000).then(() => 'HUNG'), // 挂住的话这条先到，测试失败。
        ])

        expect(result).not.toBe('HUNG')
        expect(result.interrupted).toBe(true)
    })

    test('取消只杀自己这一轮的工具，不误伤共用同一份工具的另一个调用', async () => {
        const tools = await Tool.scan(BROKEN)
        const mine = new AbortController()
        const theirs = new AbortController()

        const victim = Tool.execute({ name: 'forever', input: {}, handlers: tools.handlers, signal: mine.signal })
        const bystander = Tool.execute({ name: 'first', input: {}, handlers: tools.handlers, signal: theirs.signal })
        setTimeout(() => mine.abort(), 80)

        expect((await victim).interrupted).toBe(true)
        expect((await bystander).output.value).toBe('I-am-first') // 以前这里会被连坐杀掉，拿到"工具执行已中断"。
    })

    test('跑过工具之后进程还能正常退出', async () => {
        // 池里的 Worker 如果不 unref，事件循环永远不空，任何用了这个包的 CLI 都会卡在退出这一步。
        const child = Bun.spawn(['bun', '-e', `
            import Tool from '${new URL('../features/tool.js', import.meta.url).href}'
            const tools = await Tool.scan('./tests/fixtures/tools')
            await Tool.execute({ name: 'echo', input: { value: 'bye' }, handlers: tools.handlers })
            console.log('done')
        `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })

        const exited = await Promise.race([child.exited, Bun.sleep(8000).then(() => 'HUNG')])
        if (exited === 'HUNG') child.kill()

        expect(exited).toBe(0)
    })

    test('自带 toModelOutput 的工具返回循环引用时也不会毒化 history', async () => {
        const tools = await Tool.scan(CYCLIC_FORMAT)
        const result = await Tool.execute({ name: 'cyclicformat', input: {}, handlers: tools.handlers })

        expect(result.error).toBeTruthy()                              // 成形结果同样要过 JSON 化这一关，不能因为工具自带格式化就放行。
        expect(() => JSON.stringify(result.output)).not.toThrow()
    })

    test('并发调用不会串台', async () => {
        const tools = await Tool.scan('./tests/fixtures/tools')
        const values = ['a', 'b', 'c', 'd']
        const results = await Promise.all(values.map(value => Tool.execute({ name: 'echo', input: { value }, handlers: tools.handlers })))

        expect(results.map(result => result.output.value)).toEqual(values.map(value => `done:${value}`))
    })
})


describe('LLM 边界', () => {
    // 一个只会报错的假中转站：真实服务报错时就是这个形状。
    const failing = Bun.serve({
        port: 39931,
        fetch: () => Response.json({ error: { message: '上游负载已满', type: 'server_error' } }, { status: 503 }),
    })

    // 记录收到的请求体，用来确认我们到底发了什么字段。
    const recorded = []
    const echo = Bun.serve({
        port: 39932,
        async fetch(request) {
            recorded.push(await request.json())
            return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }], usage: {} })
        },
    })

    test('流式请求里的供应商错误会被抛出来，不再伪装成正常回答', async () => {
        const call = LLM.chat({ baseURL: `http://127.0.0.1:${failing.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true })
        expect(call).rejects.toThrow() // 以前它会返回一个空文本的"成功"结果，上层完全看不出请求失败过。
    })

    test('抛出来的错误带着 AI SDK 的可重试标记，Retry 才认得出', async () => {
        const error = await LLM.chat({ baseURL: `http://127.0.0.1:${failing.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }).catch(caught => caught)
        expect(error.isRetryable).toBe(true) // 503 该重试；以前这里是 AI_NoOutputGeneratedError，没有这个字段，重试从来不会发生。
    })

    test('默认不发 OpenAI 私有的提示词缓存字段', async () => {
        recorded.length = 0
        await LLM.chat({ baseURL: `http://127.0.0.1:${echo.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false })

        expect(recorded[0]).not.toHaveProperty('prompt_cache_key') // 实测 gpt-oss-120b 会因为这个字段直接 400。
        expect(recorded[0]).not.toHaveProperty('prompt_cache_retention')
    })

    test('显式打开 cache 时才发缓存字段', async () => {
        recorded.length = 0
        await LLM.chat({ baseURL: `http://127.0.0.1:${echo.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, cache: true })

        expect(recorded[0]).toHaveProperty('prompt_cache_key')
    })

    test('默认 toolChoice 是 auto，模型可以正常收尾', async () => {
        recorded.length = 0
        const tools = (await Tool.scan('./tests/fixtures/tools')).schema // 用真实扫描出来的 schema，保证形状和线上一致。
        await LLM.chat({ baseURL: `http://127.0.0.1:${echo.port}/v1`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, tools })

        expect(recorded[0].tool_choice).toBe('auto') // 写死 required 会让 gpt-oss-120b 在模型不想调工具时返回 tool_use_failed。
    })

    process.on('exit', () => { failing.stop(); echo.stop() })
})


describe('Agent 与 Loop', () => {
    const server = Bun.serve({
        port: 39933,
        async fetch(request) {
            await request.json()
            await Bun.sleep(120) // 留出足够窗口，让"两次 send 抢跑"这件事真的有机会发生。
            return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '回答' }, finish_reason: 'stop' }], usage: {} })
        },
    })
    const config = { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false }

    test('同一 tick 内连发两次 send，只有后一次在跑', async () => {
        const agent = Agent.create({ config })
        const first = agent.send({ input: '任务A' })
        const second = agent.send({ input: '任务B' })

        expect(agent.running.task).toBe(second)        // 第二次必定看得见第一次并顶替它。
        await Promise.allSettled([first, second])
        await first.then(() => 'finished', () => 'aborted').then(state => expect(state).toBe('aborted')) // 旧任务被停掉，而不是和新任务并排跑完。
    })

    test('send 之后立刻 stop 不会因为运行状态半成品而抛 TypeError', async () => {
        const agent = Agent.create({ config })
        const task = agent.send({ input: '马上就停' })
        const stopped = await agent.stop()

        expect(stopped).toEqual({ ok: true })
        await task.catch(() => {})
    })

    test('新指令写在旧任务收尾之后，history 顺序不错乱', async () => {
        const agent = Agent.create({ config })
        const first = agent.send({ input: '任务A' })
        const second = agent.send({ input: '任务B' })
        await Promise.allSettled([first, second])
        await second.catch(() => {})

        const said = agent.history.filter(message => message.role === 'user').map(message => message.content)
        expect(said).toEqual(['任务A', '任务B'])                       // 先说的在前。
        const indexB = agent.history.findIndex(message => message.content === '任务B')
        expect(agent.history.slice(0, indexB).every(message => message.role === 'user' || message.role === 'assistant' || message.role === 'tool')).toBe(true)
        // 旧任务被打断后写回的消息不会插到"任务B"后面——它在写之前就已经被等完了。
    })

    test('compact 和 send 抢跑时不会互相把运行状态覆盖掉', async () => {
        const agent = Agent.create({ config })
        const sending = agent.send({ input: '先发一条' })
        const compacting = agent.compact()                            // 同一 tick 紧接着手动压缩。

        expect(agent.running.task).toBe(compacting)                   // 后来的顶替先来的，而不是把它挤成孤儿。
        await Promise.allSettled([sending, compacting])
        expect(agent.running).toBeNull()                              // 都结束之后状态归零，不会留下一个停不掉的任务。
    })

    test('上下文压不动时停止压缩，不再无限烧模型请求', async () => {
        let calls = 0
        const compacting = Bun.serve({
            port: 39934,
            async fetch(request) { await request.json(); calls += 1; return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '一段总结' }, finish_reason: 'stop' }], usage: {} }) },
        })

        const agent = Agent.create({ config: { ...config, baseURL: `http://127.0.0.1:${compacting.port}/v1`, maxTokens: 20, compactThreshold: 0.8 } })
        await agent.send({ input: '你好' }).catch(() => {})

        expect(calls).toBeLessThan(20) // 修之前这里 3 秒能跑出 5500 次真实模型请求。
        compacting.stop()
    })

    test('模型给出无法解析的工具调用时不执行它，而是告诉模型重来', async () => {
        const executed = []
        const history = [History.user({ content: '开始' })]
        let round = 0

        await Loop.run({
            history,
            system: '',
            tools: {},
            llm: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', model: 'm', stream: false },
            buildContext: Context.build,
            compact: async () => '总结',
            executeTool: async request => { executed.push(request.name); return { output: { type: 'text', value: 'ran' } } },
            // 第一轮伪造一个 AI SDK 标记为 invalid 的调用，之后按正常无工具结束。
            onLLMFinish: result => {
                round += 1
                if (round === 1) result.toolCalls = [{ toolCallId: 'bad-1', toolName: 'read', input: '{"path":', dynamic: true, invalid: true, error: { message: '参数不是合法 JSON' } }]
            },
        })

        expect(executed).toEqual([])  // 以前会把未解析的参数字符串当对象喂给工具。
        expect(history.some(message => Array.isArray(message.content) && message.content.some(part => part.output?.value?.includes('无效')))).toBe(true)
    })

    process.on('exit', () => server.stop())
})
