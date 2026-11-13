/*
测试共用的夹具：假模型、临时工具目录。这个文件不叫 *.test.ts，bun test 不会把它当测试。

假模型用 AI SDK 自带的 MockLanguageModelV4：按顺序回放一组脚本化的回复，并记下每次收到的请求，
测试由此断言"这一轮发出去的是什么"（工具表、system、messages），全程没有网络请求。
*/

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import { simulateReadableStream } from 'ai'

// 一次脚本化回复：文字，或若干工具调用（可以同时有）。usage 是假的输入 token 数，用来测校准。
export type Step = { text?: string; calls?: { name: string; input?: unknown; id?: string }[]; inputTokens?: number }

// 用量的 V4 形状：只填测试关心的字段。
const usageOf = (input = 100) => ({ inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } })

// 把一步脚本变成模型的内容块。
const contentOf = (step: Step) => [
    ...(step.text ? [{ type: 'text' as const, text: step.text }] : []),
    ...(step.calls ?? []).map((call, index) => ({ type: 'tool-call' as const, toolCallId: call.id ?? `c${Math.random().toString(36).slice(2, 8)}${index}`, toolName: call.name, input: JSON.stringify(call.input ?? {}) })),
]

/*
script：按顺序回放 steps 的假模型。脚本用完后一直回最后一步。
calls 记下每次请求的 prompt 和 tools，方便断言。stream 与非流式都支持。
*/
export function script(steps: (Step | ((index: number) => Step | Promise<Step>))[], modelId = 'mock-model') {
    let index = 0
    const next = async () => { const raw = steps[Math.min(index, steps.length - 1)]!; const step = typeof raw === 'function' ? await raw(index) : raw; index += 1; return step }
    const calls: any[] = []
    const model = new MockLanguageModelV4({
        modelId,
        doGenerate: async (options: any) => {
            calls.push(options)
            const step = await next()
            return { content: contentOf(step), finishReason: { unified: step.calls?.length ? 'tool-calls' : 'stop', raw: undefined }, usage: usageOf(step.inputTokens), warnings: [] } as any
        },
        doStream: async (options: any) => {
            calls.push(options)
            const step = await next()
            const chunks: any[] = [{ type: 'stream-start', warnings: [] }]
            if (step.text) chunks.push({ type: 'text-start', id: 't' }, ...[...step.text].map(char => ({ type: 'text-delta', id: 't', delta: char })), { type: 'text-end', id: 't' })
            for (const part of contentOf(step).filter(one => one.type === 'tool-call')) chunks.push(part)
            chunks.push({ type: 'finish', finishReason: { unified: step.calls?.length ? 'tool-calls' : 'stop', raw: undefined }, usage: usageOf(step.inputTokens) })
            return { stream: simulateReadableStream({ chunks }) } as any
        },
    })
    return { model, calls }
}

// 建一个临时目录，按 { 文件名: 源码 } 写进去，返回目录路径。
export function tools(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'agent-core-'))
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)
    return dir
}

// 一个最小工具文件的源码。body 是 run 的函数体，拿得到 args。
export const tool = (name: string, body: string, extra = '') => `export default { name: '${name}', description: '${name} tool', parameters: { type: 'object', properties: { x: { type: 'number' } } }, ${extra} async run(args) { ${body} } }\n`

// 请求里发给模型的工具名（原生工具模式）。
export const toolNames = (call: any) => (call.tools ?? []).map((one: any) => one.name).sort()
