/*
shape：把工具的任意返回值整理成"能写进 history、能发给模型"的 AI SDK 工具输出块。整个项目只有这一份输出成形逻辑
（旧实现在 tool-process.js 和 utils/shape.js 各有一份，合并到这里）。

调用示例：
    await shape(await tool.run(args), { limit: 20000, toModelOutput: tool.toModelOutput, input: args, toolCallId })  // 子进程里
    await shape(await MCPTool.execute(args, options), { limit, toModelOutput: MCPTool.toModelOutput, ... })          // 主进程（MCP）里

规则：
1. 返回值可以是 { output, stop } 包装（stop:true 是工具"要求结束循环"的约定），也可以直接是值；
2. 工具自带 toModelOutput 时优先用它（可以是 async）；
3. 返回值自己就是成形的输出块（type 是 text / json / content / error-text / error-json / execution-denied）→ 原样；
4. 空返回 → 一句交代，让模型知道工具跑成功了；字符串 → text 块；Error → error-text 块；其余 → json 块；
5. 只留纯 JSON：二进制转 base64、Date 变字符串，循环引用这类序列化不了的值变成 error-text，保证子进程能把结果传回来；
6. 校验形状（旧实现 outputProblem 的规则）：text 要字符串 value、json 要有 value、content 要数组且每个部件都过
   history.check——不合法就变成一条正常的工具失败。history 只增不删，一个 AI SDK 拒收的块写进去会让之后每次请求都发不出去；
7. 超过 limit 字符时截断：保留开头 70% 和结尾 30%（报错、汇总通常在日志末尾），中间注明省略了多少并提示缩小范围；
   content 块里的文字部件同样截断，媒体部件不动。limit 缺省 = 不截断。
不导入 tools 以外的能力模块，只导入下层的 history（check / PARTS）；没有模块级可变状态。
*/

import type { ToolDefinition } from '../types.ts'
import { PARTS, check } from '../history.ts'

// AI SDK 认得的输出块类型：工具直接返回成形的块时，认出来才不会再给它套一层 json。
const BLOCK = new Set(['text', 'json', 'content', 'error-text', 'error-json', 'execution-denied'])

// shape 的产物：output 是可安全序列化的输出块；stop 表示工具要求结束；truncated 表示被截断过。
export interface Shaped { output: { type: string; value?: unknown; reason?: string }; stop?: boolean; truncated?: boolean }

/*
shape：按文件头的规则整理一个返回值。
toModelOutput 自己抛错、输出形状不合法时，把原因当作结果返回（error-text），不让成形这一步打断整轮。
*/
export async function shape(
    value: unknown,
    options: { limit?: number; toModelOutput?: ToolDefinition['toModelOutput']; input?: unknown; toolCallId?: string } = {},
): Promise<Shaped> {
    const limit = options.limit ?? Infinity
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
        // 形状校验：每种块该有的字段都在，content 的每个部件都认得、形状合法。
        const problem = (output.type === 'text' || output.type === 'error-text') && typeof output.value !== 'string' ? `${output.type} 输出块必须有字符串 value`
            : (output.type === 'json' || output.type === 'error-json') && output.value === undefined ? `${output.type} 输出块必须有 value`
            : output.type === 'execution-denied' && output.reason !== undefined && typeof output.reason !== 'string' ? 'execution-denied 输出块的 reason 必须是字符串'
            : output.type !== 'content' ? null
            : !Array.isArray(output.value) ? 'content 输出块的 value 必须是数组'
            : output.value.map((part: any) => PARTS.has(part?.type) ? check(part) : `content 块里的 ${JSON.stringify(part?.type)} 部件不合法，只能是 ${[...PARTS].join(' / ')}`).find(Boolean) ?? null
        if (problem) output = { type: 'error-text', value: `工具输出不合法：${problem}` }
    } catch (error) {
        output = { type: 'error-text', value: `工具输出无法整理：${(error as Error)?.message ?? String(error)}` }
    }
    // 截断：文字块直接截；json 块序列化后超长就改成截断过的文字（截断的 JSON 不再是合法 JSON）；content 只截文字部件。
    let truncated = false
    const cut = (text: string) => {
        if (!Number.isFinite(limit) || text.length <= limit) return text
        truncated = true
        const head = Math.floor(limit * 0.7), tail = Math.floor(limit * 0.3) // limit 很小时 tail 可能是 0：slice(-0) 会返回整段，单独挡掉。
        return `${text.slice(0, head)}\n\n……[输出过长，中间省略 ${text.length - head - tail} 个字符。请缩小范围或分页重新获取]……\n\n${tail ? text.slice(-tail) : ''}`
    }
    if (output.type === 'text' || output.type === 'error-text') output = { ...output, value: cut(output.value) }
    else if (output.type === 'json' || output.type === 'error-json') {
        const text = JSON.stringify(output.value)
        const short = cut(text)
        if (short !== text) output = { type: output.type === 'json' ? 'text' : 'error-text', value: short }
    } else if (output.type === 'content') output = { ...output, value: output.value.map((part: any) => part.type === 'text' ? { ...part, text: cut(part.text) } : part) }
    return { output, ...(stop ? { stop } : {}), ...(truncated ? { truncated } : {}) }
}
