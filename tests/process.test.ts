/*
子进程与外部工具的测试：stop() 立即杀掉卡死的工具并补"已取消"、只杀本实例、坏插件文件被跳过并警告、
MCP 工具（用一个本地的假 MCP 服务器）。这些用例会真的起子进程，所以单独放一个文件。
*/

import { describe, expect, test } from 'bun:test'
import { Agent } from '../index.ts'
import type { Message } from '../index.ts'
import { script, tools, tool, toolNames } from './helpers.ts'

const results = (history: Message[]) => history.flatMap(message => message.role === 'tool' ? (message.content as any[]) : [])

describe('stop()', () => {
    test('立即杀掉同步死循环的工具，补一条已取消结果，send 以 kind aborted 拒绝', async () => {
        const dir = tools({ 'spin.ts': tool('spin', 'while (true) {}') })
        const { model } = script([{ calls: [{ name: 'spin', id: 'spin1' }] }, { text: '不该走到这里' }])
        const agent: Agent = Agent.create({ model, tools: [dir], stream: false })
        let stopped = 0
        let confirmed: Promise<unknown> = Promise.resolve()
        const running = agent.send('hi', { onToolCall: () => { setTimeout(() => { stopped = Date.now(); confirmed = agent.stop() }, 300) } })
        const failure = await running.catch(e => e)
        expect(failure.kind).toBe('aborted')
        expect(Date.now() - stopped).toBeLessThan(1000)                   // 不等工具反应
        expect(await confirmed).toEqual({ stopped: true, wasRunning: true, killed: 1 }) // 子进程确认退出、循环收尾后才兑现
        expect(await agent.stop()).toEqual({ stopped: true, wasRunning: false, killed: 0 })
        const [result] = results(agent.history)
        expect(result).toMatchObject({ toolCallId: 'spin1', output: { type: 'error-text', value: '工具执行已取消' } })
    })

    test('只杀本实例的子进程：另一台实例的工具照常跑完', async () => {
        const dir = tools({ 'nap.ts': tool('nap', 'await Bun.sleep(800); return "睡醒了"') })
        const a = script([{ calls: [{ name: 'nap' }] }, { text: 'A' }])
        const b = script([{ calls: [{ name: 'nap' }] }, { text: 'B' }])
        const agentA: Agent = Agent.create({ model: a.model, tools: [dir], stream: false, noToolRounds: 1 })
        const agentB: Agent = Agent.create({ model: b.model, tools: [dir], stream: false, noToolRounds: 1 })
        const runA = agentA.send('hi', { onToolCall: () => { setTimeout(() => void agentA.stop(), 200) } }).catch(e => e)
        const answerB = await agentB.send('hi')
        expect((await runA).kind).toBe('aborted')
        expect(answerB.text).toBe('B')
        expect(results(agentB.history)[0].output.value).toBe('睡醒了')
    })
})

describe('坏插件文件', () => {
    test('语法错误、契约不符、顶层死循环的文件被跳过并通过 onWarning 警告，好工具照常可用', async () => {
        const dir = tools({
            'good.ts': tool('good', 'return "好"'),
            'syntax.ts': 'export default { name: ',
            'norun.ts': "export default { name: 'norun', description: 'x', parameters: { type: 'object' } }",
            'spin.ts': "while (true) {}\nexport default {}",
        })
        const { model, calls } = script([{ calls: [{ name: 'good' }] }, { text: '好' }])
        const warnings: string[] = []
        const agent = Agent.create({ model, tools: [dir], stream: false, noToolRounds: 1 })
        await agent.send('hi', { onWarning: warning => warnings.push(warning.path ?? '') })
        expect(toolNames(calls[0])).toEqual(['good'])
        expect(warnings.map(path => path.split('/').pop()).sort()).toEqual(['norun.ts', 'spin.ts', 'syntax.ts']) // 同一个坏文件只警告一次
        expect(results(agent.history)[0].output.value).toBe('好')
    }, 15000)
})

describe('MCP', () => {
    // 一个最小的 Streamable HTTP MCP 服务器：只回 JSON（不开 SSE），实现 initialize / tools/list / tools/call。
    // delay：每个请求先等这么久（毫秒），模拟慢服务器。
    const server = (delay = 0) => Bun.serve({
        port: 0,
        async fetch(request) {
            await Bun.sleep(delay)
            if (request.method !== 'POST') return new Response(null, { status: 405 })
            const message = await request.json() as any
            if (message.id === undefined) return new Response(null, { status: 202 })      // 通知：不需要回复
            const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: message.id, result })
            if (message.method === 'initialize') return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } })
            if (message.method === 'tools/list') return reply({ tools: [{ name: 'echo', description: '原样返回', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] })
            if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: `echo:${message.params.arguments.text}` }] })
            return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
        },
    })

    test('agent.MCP.list 的工具加 name 前缀进工具表，在主进程执行', async () => {
        const fake = server()
        try {
            const { model, calls } = script([{ calls: [{ name: 'fake_echo', input: { text: '你好' } }] }, { text: '好' }])
            const agent = Agent.create({ model, stream: false, noToolRounds: 1, MCP: [{ name: 'fake', url: `http://localhost:${fake.port}/mcp` }] })
            await Bun.sleep(300)                                             // create 时就在后台开连；连上之后的请求才带它的工具
            await agent.send('hi')
            expect(toolNames(calls[0])).toEqual(['fake_echo'])
            expect(JSON.stringify(results(agent.history)[0].output)).toContain('echo:你好')
        } finally { fake.stop(true) }
    })

    test('单条 MCP 临时关闭：enabled false 不连接；MCP.close 立即断开、下一轮工具消失；MCP.open 立刻开连；整份替换 MCP.list 也生效', async () => {
        const fake = server()
        try {
            const { model, calls } = script([{ text: '好' }])
            const mcp = [{ name: 'fake', url: `http://localhost:${fake.port}/mcp`, enabled: false }]
            const agent = Agent.create({ model, stream: false, noToolRounds: 1, MCP: mcp })
            await agent.send('1')
            expect(toolNames(calls[0])).toEqual([])
            expect(agent.MCP.open('fake')).toEqual({ name: 'fake', found: true, enabled: true })
            await Bun.sleep(300)
            await agent.send('2')
            expect(toolNames(calls[1])).toEqual(['fake_echo'])
            expect(await agent.MCP.close('fake')).toEqual({ name: 'fake', found: true, enabled: false, closed: true })
            expect(mcp[0]!.enabled).toBe(false)                            // 原地替换元素，宿主手里的数组同步可见
            await agent.send('3')
            expect(toolNames(calls[2])).toEqual([])
            expect(await agent.MCP.close('nope')).toEqual({ name: 'nope', found: false, enabled: false, closed: false })
            agent.MCP.list = [{ name: 'fake', url: `http://localhost:${fake.port}/mcp` }] // 整份换成新数组：下一轮按新数组连接
            const { open, close } = agent.MCP                               // 解构出来单独调用也照常工作
            await agent.send('4')                                           // 这一轮开头发现新元素并开连，但不等它
            expect(toolNames(calls[3])).toEqual([])
            await Bun.sleep(300)
            await agent.send('5')
            expect(toolNames(calls[4])).toEqual(['fake_echo'])
            expect((await close('fake')).closed).toBe(true)
            expect(agent.MCP.list[0]!.enabled).toBe(false)
            expect(open('fake').enabled).toBe(true)
        } finally { fake.stop(true) }
    })

    test('慢服务器不拖慢第一次请求；一次 send 中途连上，下一轮请求就带上它的工具', async () => {
        const slow = server(400)                                             // 握手要好几个来回，每个 400ms
        const dir = tools({ 'nap.ts': tool('nap', 'await Bun.sleep(2500); return "醒了"') })
        const at: number[] = []
        const started = Date.now()
        const { model, calls } = script([() => { at.push(Date.now() - started); return { calls: [{ name: 'nap' }] } }, { text: '好' }])
        try {
            const agent = Agent.create({ model, tools: [dir], stream: false, noToolRounds: 1, MCP: [{ name: 'slow', url: `http://localhost:${slow.port}/mcp` }] })
            await agent.send('hi')
            expect(at[0]!).toBeLessThan(400)                                // 第一次请求没等连接
            expect(toolNames(calls[0])).toEqual(['nap'])
            expect(toolNames(calls[1])).toEqual(['nap', 'slow_echo'])       // 工具跑着的时候连上了：下一轮就有
        } finally { slow.stop(true) }
    }, 15000)
})

describe('工具子进程细节', () => {
    test('超时：错误里带上已经输出的部分；yield 实时转给宿主；被 SIGKILL 与被取消分得开；BUN_BE_BUN 不漏给工具', async () => {
        const dir = tools({
            'slow.ts': tool('slow', "console.log('已完成一半'); await Bun.sleep(5000)", 'timeout: 500,'),
            'steps.ts': "export default { name: 'steps', description: 'x', parameters: { type: 'object' }, async *run() { yield '第一步'; await Bun.sleep(300); yield '第二步' } }\n",
            'oom.ts': tool('oom', "process.kill(process.pid, 'SIGKILL')"),
            'env.ts': tool('env', "return [process.env.BUN_BE_BUN ?? 'none', process.env.AGENT_CORE_CHILD ?? 'none'].join(',')"),
        })
        const { model } = script([{ calls: [{ name: 'slow', id: 's' }, { name: 'steps', id: 'g' }, { name: 'oom', id: 'o' }, { name: 'env', id: 'e' }] }, { text: '好' }])
        const agent = Agent.create({ model, tools: [dir], stream: false, noToolRounds: 1 })
        const outputs: { toolCallId: string; data: string; at: number }[] = []
        const started = Date.now()
        await agent.send('hi', { onToolOutput: output => { outputs.push({ ...output, at: Date.now() - started }) } })
        const [slow, steps, oom, env] = results(agent.history)
        expect(slow.output.value).toContain('工具执行超时')
        expect(slow.output.value).toContain('已完成一半')
        const first = outputs.find(output => output.toolCallId === 'g' && output.data.includes('第一步'))!
        const second = outputs.find(output => output.toolCallId === 'g' && output.data.includes('第二步'))!
        expect(second.at - first.at).toBeGreaterThan(200)                  // 第一步没等到工具结束才出现
        expect(steps.output.type).not.toBe('error-text')
        expect(oom.output.value).toContain('SIGKILL')
        expect(oom.output.value).not.toContain('已取消')
        if (process.env.BUN_BE_BUN === undefined) expect(env.output.value).toBe('none,none')
    }, 15000)
})

describe('MCP 连接不阻塞', () => {
    test('连不上的服务器：这一轮照常进行，onWarning 报一次，之后不自动重连；切一下开关才重试', async () => {
        const dead = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 500 }) })
        const { model } = script([{ text: '好' }])
        const agent = Agent.create({ model, stream: false, MCP: [{ name: 'dead', url: `http://localhost:${dead.port}/mcp` }] })
        const warnings: string[] = []
        const onWarning = (warning: { message: string }) => { warnings.push(warning.message) }
        try {
            await Bun.sleep(300)                                             // create 后在后台失败：那时没有 send，原因先记下
            await agent.send('1', { onWarning })                             // 下一次请求开始时报出来
            await agent.send('2', { onWarning })
            expect(warnings.filter(message => message.includes('dead'))).toHaveLength(1)
            expect(await agent.MCP.close('dead')).toMatchObject({ found: true, closed: false }) // 失败的记录只是被移出
            agent.MCP.open('dead')
            await Bun.sleep(300)
            await agent.send('3', { onWarning })
            expect(warnings.filter(message => message.includes('dead'))).toHaveLength(2)
        } finally { dead.stop(true) }
    })

    test('一直不回应的服务器：请求一点也不等它，stop() 也不被它拖住', async () => {
        const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
        try {
            const { model, calls } = script([{ text: '好' }])
            const agent = Agent.create({ model, stream: false, MCP: [{ name: 'hang', url: `http://localhost:${hang.port}/mcp` }] })
            const started = Date.now()
            await agent.send('1')
            expect(Date.now() - started).toBeLessThan(300)
            expect(toolNames(calls[0])).toEqual([])
            model.doGenerate = (options: any) => new Promise((_, reject) => options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal.reason)))
            const again = agent.send('2').catch(e => e)                      // 仍在连接中：照常发请求
            await Bun.sleep(50)
            const stopping = Date.now()
            await agent.stop()
            expect(Date.now() - stopping).toBeLessThan(500)
            expect((await again).kind).toBe('aborted')
        } finally { hang.stop(true) }
    })
})

describe('请求体', () => {
    test('chat：prompt_cache_key 沿用旧实现的哈希；includeUsage: false 时流式请求不带 stream_options', async () => {
        const bodies: any[] = []
        const fake = Bun.serve({
            port: 0,
            async fetch(request) {
                const body = await request.json()
                bodies.push(body)
                const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
                return new Response(chunk({ role: 'assistant', content: '好' }) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
            },
        })
        try {
            const baseURL = `http://localhost:${fake.port}/v1`
            const messages = [{ role: 'user' as const, content: 'hi' }]
            expect((await Agent.LLM.ask({ model: 'm', baseURL, apiKey: 'k', system: '系统', messages })).text).toBe('好')
            await Agent.LLM.ask({ model: 'm', baseURL, apiKey: 'k', system: '系统', messages, includeUsage: false })
            expect(bodies[0].prompt_cache_key).toBe(`agent:${baseURL}:m:${Bun.hash(JSON.stringify('系统'))}`)
            expect(bodies[0].stream_options).toEqual({ include_usage: true })
            expect(bodies[1].stream_options).toBeUndefined()
        } finally { fake.stop(true) }
    })
})
