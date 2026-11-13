/*
文字工具（模拟工具）的"写进提示词"一半：给没有原生工具能力的模型，用文字描述工具、用文字回放历史调用。

调用示例（在 model/ask 里，仅当 request.textTools 为 true）：
    const spec = describe(request.tools)                       // 工具说明 + 解析时要用的名字 / 参数表
    const messages = render(request.messages)                  // 历史里的 tool-call / tool-result 改写成文字
    system = [request.system, spec.instructions].join('\n\n')

格式（Roo Code / Cline 同样用带标签的文本；这里用 JSON 体，因为它能保住参数的原始类型）：

    <tool_call>
    {"name": "add", "arguments": {"a": 1, "b": 2}}
    </tool_call>

同一个回复里可以有多个块。工具结果用 <tool_result> 回给模型，只有运行时会写这个标签。

为什么显式开关：旧实现有一个进程级的"哪些模型不支持原生工具"集合自动降级，违反多实例隔离，已删除。
现在开不开由宿主在 config.textTools 里说了算，同一模型的两个实例互不影响。
history 本身永远是标准形状，这里只在"出门"时转换，所以中途开关文字工具、换模型都不会破坏历史。
本文件没有模块级可变状态（旧的 prepare 缓存删掉：参数已经是 JSON Schema，每轮现算几乎没有成本）。
*/

import type { JSONSchema7, ModelMessage } from 'ai'

// 文字协议的规格：parse 按它识别回复里的调用。
export interface TextToolSpec {
    names: string[]                                    // 可调用的工具名
    params: Record<string, Record<string, string>>     // 工具名 → 参数名 → 类型（解析时把字符串还原成对应类型）
    instructions: string                               // 写进 system 的工具说明和调用格式
}

// 给模型的说明书开头：一句话说清格式和规则，后面逐个列出工具。
const HEADER = `# Tool calling

You can use the tools listed at the end of this message. To call a tool, output exactly this block:

<tool_call>
{"name": "tool_name", "arguments": {"argument": "value"}}
</tool_call>

Rules:
- Put one JSON object inside each <tool_call> block. "name" is the tool name, "arguments" is an object of arguments.
- You may emit several <tool_call> blocks in one reply.
- After emitting tool calls, stop immediately and wait. The results come back in a message containing <tool_result> blocks.
- Never write a <tool_result> block yourself; only the runtime produces those.
- When no tool is needed, answer normally without any <tool_call> block.

Tools:`

/*
describe：把工具描述表变成文字协议规格。
每个工具一行：名字、说明、参数的 JSON Schema；params 记下每个参数的 type，parse 把 XML 写法的字符串参数转回原类型。
没有工具时返回 null，ask 就不改提示词。
*/
export function describe(tools: Record<string, { description: string; parameters: JSONSchema7 }> | undefined): TextToolSpec | null {
    if (!tools || !Object.keys(tools).length) return null
    const names = Object.keys(tools)
    const params: TextToolSpec['params'] = {}
    const lines: string[] = []
    for (const name of names) {
        const { description, parameters } = tools[name]!
        // 参数名 → 类型：只读第一层 properties，嵌套结构在解析时按 JSON 处理。
        params[name] = Object.fromEntries(Object.entries(parameters?.properties ?? {}).map(([key, one]) => [key, String((one as JSONSchema7)?.type ?? '')]))
        lines.push(`- ${name}: ${description ?? ''}${parameters ? `\n  arguments: ${JSON.stringify(parameters)}` : ''}`)
    }
    return { names, params, instructions: `${HEADER}\n${lines.join('\n')}` }
}

/*
render：把 messages 里的原生工具消息改写成纯文字，让不认识 tool role 的模型也能读懂前情。

- assistant 的 tool-call 块写成和说明书相同格式的 <tool_call> 文本；
- tool 消息改成 user 消息，每个结果写成一段 <tool_result name="…">，结果里的媒体块原样跟在后面；
- 改写后相邻的同角色消息合并（工具结果降级后会和后面的 user 挨在一起，部分接口不接受连续同角色）；
- 不改原数组，返回新数组。
*/
export function render(messages: ModelMessage[]): ModelMessage[] {
    const out: { role: string; content: any }[] = []
    // 消息内容统一成块数组：字符串摊成一个文字块，方便合并。
    const parts = (content: unknown): Record<string, any>[] => Array.isArray(content) ? content : typeof content === 'string' && content ? [{ type: 'text', text: content }] : []
    for (const message of messages) {
        if (message.role === 'tool') {
            const content = parts(message.content).flatMap(part => {
                if (part.type !== 'tool-result') return []
                const output = part.output ?? {}
                // 工具输出块的几种固定形状，各自转成给模型看的文字；content 里的媒体块原样保留（模型支持图就能继续看）。
                const blocks: Record<string, any>[] = output.type === 'text' || output.type === 'error-text' ? [{ type: 'text', text: output.value }]
                    : output.type === 'execution-denied' ? [{ type: 'text', text: `execution denied: ${output.reason ?? ''}` }]
                    : output.type === 'content' ? output.value.map((one: any) => one.type === 'text' ? { type: 'text', text: one.text } : one)
                    : [{ type: 'text', text: JSON.stringify(output.value ?? output) }]
                const text = blocks.filter(one => one.type === 'text').map(one => one.text).join('\n')
                return [{ type: 'text', text: `<tool_result name="${part.toolName}">\n${text}\n</tool_result>` }, ...blocks.filter(one => one.type !== 'text')]
            })
            out.push({ role: 'user', content })
        } else if (message.role === 'assistant') {
            const content = parts(message.content).map(part => part.type === 'tool-call'
                ? { type: 'text', text: `<tool_call>\n${JSON.stringify({ name: part.toolName, arguments: part.input ?? {} })}\n</tool_call>` }
                : part)
            out.push({ ...message, content })
        } else out.push(message)
        // 和上一条同角色就合并成一条（system 不合并）。
        const last = out.at(-1)!, previous = out.at(-2)
        if (previous && previous.role === last.role && last.role !== 'system') {
            out.splice(-2, 2, { ...previous, content: [...parts(previous.content), ...parts(last.content)] })
        }
    }
    return out as ModelMessage[]
}
