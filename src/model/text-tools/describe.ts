/*
文字工具（模拟工具）的"写进提示词"一半：给没有原生工具能力的模型，用文字描述工具、用文字回放历史调用。

调用示例（在 model/ask 里，仅当 request.textTools 为 true）：
    const spec = describe(request.tools)                       // 工具说明 + 解析时要用的名字 / 参数表
    const messages = render(request.messages)                  // 历史里的 tool-call / tool-result 改写成文字
    system = [request.system, spec.instructions].join('\n\n')

为什么显式开关：旧实现有一个进程级的"哪些模型不支持原生工具"集合自动降级，违反多实例隔离，已删除。
现在开不开由宿主在 config.textTools 里说了算，同一模型的两个实例互不影响。
本文件没有模块级可变状态（旧的 prepare 缓存删掉：每轮现算，成本可以忽略）。
*/

import type { JSONSchema7, ModelMessage } from 'ai'

// 文字协议的规格：parse 按它识别回复里的调用。
export interface TextToolSpec {
    names: string[]                                    // 可调用的工具名
    params: Record<string, Record<string, string>>     // 工具名 → 参数名 → 类型（解析时把字符串还原成对应类型）
    instructions: string                               // 写进 system 的工具说明和调用格式
}

/*
describe：把工具描述表变成文字协议规格。
instructions 里写清楚每个工具的名字、说明、参数（从 JSON Schema 读出名字、类型、是否必填），
以及调用格式（XML 风格的标签，一次回复可以有多个调用），和"调用后等结果、不要自己编结果"的约束。
没有工具时返回 null，ask 就不改提示词。
*/
export function describe(tools: Record<string, { description: string; parameters: JSONSchema7 }> | undefined): TextToolSpec | null {
    throw new Error('TODO')
}

/*
render：把 messages 里的原生工具消息改写成纯文字，让不认识 tool role 的模型也能读懂前情。
assistant 的 tool-call 块写成与 instructions 相同格式的调用文本；tool 消息改成 user 消息，内容是"工具 X 的结果：…"。
其它消息原样保留；不改原数组，返回新数组。
*/
export function render(messages: ModelMessage[]): ModelMessage[] {
    throw new Error('TODO')
}
