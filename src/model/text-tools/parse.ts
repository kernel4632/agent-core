/*
文字工具（模拟工具）的"从回复里读回来"一半：从模型回复的纯文字里解析出工具调用。

调用示例（在 model/ask 里，仅当 request.textTools 为 true）：
    const { text, calls } = parse(reply.text, spec)   // text 是去掉调用标签后的正文，calls 是 ToolCall[]

容错（这些都是实测里模型真会写错的地方）：
- 标签大小写、多余空白、代码块包裹都认；
- 参数值是 JSON 但写坏了（尾逗号、单引号）时用 jsonrepair 修一次再解析；
- 参数按 spec.params 里的类型还原（"3" → 3，"true" → true）；
- 不在 spec.names 里的工具名不当调用，原样留在正文里。
toolCallId 用 nanoid 现生成；本文件没有模块级可变状态（旧的 sequence 计数器删除）。
*/

import type { ToolCall } from '../../types.ts'
import type { TextToolSpec } from './describe.ts'

/*
parse：按文件头的规则解析一段回复文字，返回正文和调用列表；调用顺序与文字里出现的顺序一致。
解析不出任何调用时 calls 为空数组，text 原样返回。
*/
export function parse(text: string, spec: TextToolSpec): { text: string; calls: ToolCall[] } {
    throw new Error('TODO')
}
