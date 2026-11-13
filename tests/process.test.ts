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
        const running = agent.send('hi', { onToolCall: () => { setTimeout(() => { stopped = Date.now(); void agent.stop() }, 300) } })
        const failure = await running.catch(e => e)
        expect(failure.kind).toBe('aborted')
        expect(Date.now() - stopped).toBeLessThan(1000)                   // 不等工具反应
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
    const server = () => Bun.serve({
        port: 0,
        async fetch(request) {
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

    test('agent.mcp 的工具加 name 前缀进工具表，在主进程执行', async () => {
        const fake = server()
        try {
            const { model, calls } = script([{ calls: [{ name: 'fake_echo', input: { text: '你好' } }] }, { text: '好' }])
            const agent = Agent.create({ model, stream: false, noToolRounds: 1, mcp: [{ name: 'fake', url: `http://localhost:${fake.port}/mcp` }] })
            await agent.send('hi')
            expect(toolNames(calls[0])).toEqual(['fake_echo'])
            expect(JSON.stringify(results(agent.history)[0].output)).toContain('echo:你好')
        } finally { fake.stop(true) }
    })
})
