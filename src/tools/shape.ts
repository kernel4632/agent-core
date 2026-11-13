/*
shape：把工具的任意返回值整理成"能写进 history、能发给模型"的形状。整个项目只有这一份输出成形逻辑
（旧实现在 tool-process.js 和 utils/shape.js 各有一份，合并到这里）。

调用示例：
    shape(await tool.run(args), { limit: 20000, toModelOutput: tool.toModelOutput })   // 子进程里
    shape(await mcpTool.execute(args), { limit })                                       // 主进程（MCP）里

规则：
- 先按工具自己的 toModelOutput 改写（有的话）；
- 字符串原样；能 JSON 序列化的对象原样；Error 变成 { error: message }；
  undefined → 空串；二进制、函数、循环引用等不能序列化的值转成说明文字，保证子进程能把结果传回来；
- { stop: true } 是工具"要求结束循环"的约定，原样保留 stop 标记；
- 超过 limit 字符时截断，并在末尾注明截掉了多少，防止一个工具结果撑爆上下文。
纯函数，不导入任何本项目文件（只 import type），没有模块级状态。
*/

import type { ToolDefinition } from '../types.ts'

// 默认单个工具结果最多保留的字符数；config.maxToolOutput 可改，Infinity 表示不截断。
export const DEFAULT_MAX_TOOL_OUTPUT = 20000

// shape 的产物：output 已可安全序列化；stop 表示工具要求结束；truncated 表示被截断过。
export interface Shaped { output: unknown; stop?: boolean; truncated?: boolean }

/*
shape：按文件头的规则整理一个返回值。limit 缺省用 DEFAULT_MAX_TOOL_OUTPUT。
toModelOutput 自己抛错时，把错误当作结果返回（{ error }），不让成形这一步打断整轮。
*/
export function shape(value: unknown, options: { limit?: number; toModelOutput?: ToolDefinition['toModelOutput'] } = {}): Shaped {
    throw new Error('TODO')
}
