/*
run：执行一轮里模型发出的全部工具调用。全部并行、不设上限，结果按模型发出调用的顺序返回。

调用示例（在 loop/run 里，权限检查之后）：
    const results = await run(calls, { metas, mcpTools }, state.internal.procs, { signal, limit, onOutput })

为什么全并行：模型一次发出多个调用即表示它们相互独立，内核不擅自改变语义（issue #30 第 8 步）。

规则：
- 普通工具（名字在 metas 里）：tools/spawn 起子进程，mode 'run'，超时取工具自己的 timeout；
  结果已经在子进程里经过 shape；被杀返回 cancelled，超时 / 崩溃 / 抛错变成带 error 的结果；
- MCP 工具（名字在 mcpTools 里）：主进程调 execute(input, { abortSignal: signal })，结果交给 shape；
- 名字两边都找不到（模型编的、或这一轮刚被宿主删掉）：返回 error 结果，告诉模型这个工具不存在；
- 文字工具解析出的坏调用（input 带 __invalid）：不执行，直接返回 error 结果，让模型重写；
- 被拒绝权限的调用不会进到这里（loop 已经直接写了拒绝结果）；
- 永远不抛错：工具的错都是结果，写进 history 交给模型。
导入：同目录 spawn、shape。
*/

import type { Tool } from 'ai'
import type { Subprocess } from 'bun'
import type { ToolCall, ToolMeta, ToolResult } from '../types.ts'
import { spawn } from './spawn.ts'
import { shape } from './shape.ts'

// 这一轮可执行的工具：普通工具的元数据（按名字查路径和超时）和 MCP 工具（带 execute）。
export interface Runnable { metas: ToolMeta[]; mcpTools: Record<string, Tool> }

/*
run：按文件头的规则并行执行 calls，返回与 calls 一一对应、顺序相同的结果。
onOutput 把子进程的实时输出带上 toolCallId 交给宿主；signal 取消时 MCP 调用被中断，
普通工具的子进程由 agent.stop() 的 killAll 杀掉。
*/
export async function run(
    calls: ToolCall[],
    tools: Runnable,
    procs: Set<Subprocess>,
    options: { signal?: AbortSignal; limit?: number; onOutput?: (output: { toolCallId: string; stream: 'stdout' | 'stderr'; data: string }) => void } = {},
): Promise<ToolResult[]> {
    const { signal, limit, onOutput } = options
    // 一个调用的失败结果：错误也写成 error-text 输出块，模型才能读到原因。
    const failed = (call: ToolCall, error: string, extra: Partial<ToolResult> = {}): ToolResult => ({ ...call, output: { type: 'error-text', value: error }, error, ...extra })
    return Promise.all(calls.map(async (call): Promise<ToolResult> => {   // Promise.all 的结果顺序就是 calls 的顺序。
        const invalid = (call.input as Record<string, unknown> | null)?.__invalid
        if (invalid) return failed(call, `工具调用无效：${invalid}`)
        if (signal?.aborted) return failed(call, '工具执行已取消', { cancelled: true })
        const meta = tools.metas.find(one => one.name === call.toolName)
        if (meta) {
            const result = await spawn({ mode: 'run', path: meta.path, args: call.input, limit, toolCallId: call.toolCallId }, procs, {
                timeout: meta.timeout,
                onOutput: (stream, data) => onOutput?.({ toolCallId: call.toolCallId, stream, data }),
            })
            if (result.ok) return { ...call, output: result.output, path: meta.path, ...(result.stop ? { stop: true } : {}) }
            return failed(call, result.error, { path: meta.path, ...(result.killed ? { cancelled: true } : {}) })
        }
        const mcp = tools.mcpTools[call.toolName]
        if (mcp?.execute) {
            try {
                const raw = await mcp.execute(call.input, { toolCallId: call.toolCallId, messages: [], abortSignal: signal } as any)
                const shaped = await shape(raw, { limit, toModelOutput: mcp.toModelOutput as any, input: call.input, toolCallId: call.toolCallId })
                return { ...call, output: shaped.output, ...(shaped.stop ? { stop: true } : {}) }
            } catch (error) {
                if (signal?.aborted) return failed(call, '工具执行已取消', { cancelled: true })
                return failed(call, `工具执行失败：${(error as Error)?.message ?? String(error)}`)
            }
        }
        return failed(call, `工具 ${call.toolName} 不存在（可能已被移除），请改用可用的工具`)
    }))
}
