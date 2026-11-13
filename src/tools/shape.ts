/*
shape：把工具的任意返回值整理成"能写进 history、能发给模型"的 AI SDK 工具输出块。整个项目只有这一份输出成形逻辑
（旧实现在 tool-process.js 和 utils/shape.js 各有一份，合并到这里）。

调用示例：
    await shape(await tool.run(args), { limit: 20000, toModelOutput: tool.toModelOutput, input: args, toolCallId })  // 子进程里
    await shape(await mcpTool.execute(args, options), { limit, toModelOutput: mcpTool.toModelOutput, ... })          // 主进程（MCP）里

规则：
1. 返回值可以是 { output, stop } 包装（stop:true 是工具"要求结束循环"的约定），也可以直接是值；
2. 工具自带 toModelOutput 时优先用它（可以是 async）；
3. 返回值自己就是成形的输出块（type 是 text / json / content / error-text / error-json / execution-denied）→ 原样；
4. 空返回 → 一句交代，让模型知道工具跑成功了；字符串 → text 块；Error → error-text 块；其余 → json 块；
5. 只留纯 JSON：二进制转 base64、Date 变字符串，循环引用这类序列化不了的值变成 error-text，保证子进程能把结果传回来；
6. 超过 limit 字符时截断，并在末尾注明截掉了多少，防止一个工具结果撑爆上下文。
纯函数，不导入任何本项目文件（只 import type），没有模块级可变状态。
*/

import type { ToolDefinition } from '../types.ts'

// 默认单个工具结果最多保留的字符数；config.maxToolOutput 可改，Infinity 表示不截断。
export const DEFAULT_MAX_TOOL_OUTPUT = 20000

// AI SDK 认得的输出块类型：工具直接返回成形的块时，认出来才不会再给它套一层 json。
const BLOCK = new Set(['text', 'json', 'content', 'error-text', 'error-json', 'execution-denied'])

// shape 的产物：output 是可安全序列化的输出块；stop 表示工具要求结束；truncated 表示被截断过。
export interface Shaped { output: { type: string; value?: unknown; reason?: string }; stop?: boolean; truncated?: boolean }

/*
shape：按文件头的规则整理一个返回值。limit 缺省用 DEFAULT_MAX_TOOL_OUTPUT。
toModelOutput 自己抛错时，把错误当作结果返回（error-text），不让成形这一步打断整轮。
*/
export async function shape(
    value: unknown,
    options: { limit?: number; toModelOutput?: ToolDefinition['toModelOutput']; input?: unknown; toolCallId?: string } = {},
): Promise<Shaped> {
    const limit = options.limit ?? DEFAULT_MAX_TOOL_OUTPUT
    const wrapper = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
    const stop = wrapper?.stop === true                                   // { stop: true } 或 { output, stop: true }
    const inner = wrapper && 'output' in wrapper ? wrapper.output : stop ? undefined : value // 只有 stop 标记、没有 output 时当空返回。
    let output: any
    try {
        output = options.toModelOutput ? await options.toModelOutput({ output: inner, input: options.input, toolCallId: options.toolCallId ?? '' })
            : inner && typeof inner === 'object' && BLOCK.has((inner as any).type) ? inner          // 工具自己给了成形的块（图片、多模态结果走这条路）。
            : inner instanceof Error ? { type: 'error-text', value: inner.message || String(inner) }
            : inner === undefined || inner === null || inner === '' ? { type: 'text', value: '工具执行成功，但没有输出' }
            : typeof inner === 'string' ? { type: 'text', value: inner }
            : { type: 'json', value: inner }
        if (!output || typeof output !== 'object' || !BLOCK.has(output.type)) output = { type: 'json', value: output ?? null } // toModelOutput 返回了裸值：兜成 json。
        // 只留纯 JSON：二进制转 base64，循环引用会在这里抛错、变成一条正常的工具失败。
        output = JSON.parse(JSON.stringify(output, (_key, one) => one instanceof ArrayBuffer ? Buffer.from(new Uint8Array(one)).toString('base64') : one instanceof Uint8Array ? Buffer.from(one).toString('base64') : one))
    } catch (error) {
        output = { type: 'error-text', value: `工具输出无法整理：${(error as Error)?.message ?? String(error)}` }
    }
    // 截断：文字块直接截；json 块序列化后超长就改成截断过的文字（截断的 JSON 不再是合法 JSON）。content 块里多是媒体，不截。
    let truncated = false
    if (Number.isFinite(limit)) {
        const text = output.type === 'text' || output.type === 'error-text' ? String(output.value) : output.type === 'json' || output.type === 'error-json' ? JSON.stringify(output.value) : null
        if (text !== null && text.length > limit) {
            truncated = true
            output = { type: output.type.startsWith('error') ? 'error-text' : 'text', value: `${text.slice(0, limit)}\n…（输出过长，已截掉 ${text.length - limit} 个字符）` }
        }
    }
    return { output, ...(stop ? { stop } : {}), ...(truncated ? { truncated } : {}) }
}
