/*
文字工具（模拟工具）的"从回复里读回来"一半：从模型回复的纯文字里解析出工具调用。

调用示例（在 model/ask 里，仅当 request.textTools 为 true）：
    const { text, calls } = parse(reply.text, spec)   // text 是去掉调用标签后的正文，calls 是 ToolCall[]

认三种写法（都是实测里模型真会写的）：
1. 主格式 <tool_call>{"name":…,"arguments":…}</tool_call>，最后一块没闭合（被截断）但 JSON 完整也认，JSON 也没写完就标 invalid（gemini 实录：截断的调用被修补成空参数执行，循环停不下来）；
   块里"工具名一行 + 参数 JSON"（glm-flash 实录）也认；
2. Roo Code / Cline 风格：工具名做标签、参数做子标签，<read_file><path>a.js</path></read_file>；
3. 裸 JSON 代码块 ```json {...} ```，但只认已注册的工具名，避免把讲解示例当成调用。
容错：JSON 写坏了（围栏、尾逗号、未闭合、无引号键）交给 jsonrepair 修；参数按 spec.params 的类型还原；
模型自己编造的 <tool_result> 及其后面的内容全部丢掉——把幻觉当上下文会让它以为工具真跑过了。
toolCallId 用 nanoid 现生成；本文件没有模块级可变状态（旧的 sequence 计数器删除）。
*/

import { nanoid } from 'nanoid'
import { jsonrepair } from 'jsonrepair'
import type { ToolCall } from '../../types.ts'
import type { TextToolSpec } from './describe.ts'

/*
parse：按文件头的规则解析一段回复文字，返回正文和调用列表；调用顺序与文字里出现的顺序一致。
读不出参数的坏块不悄悄丢掉：工具名还能抠出来就生成一个带 invalid（原因）的调用——和原生调用里 AI SDK 标记的坏调用同一种形状，
loop 不执行它、直接把原因回给模型让它重写；连名字都没有就不算调用。解析不出任何调用时 calls 为空，text 原样返回。
*/
export function parse(text: string, spec: TextToolSpec): { text: string; calls: ToolCall[] } {
    const source = typeof text === 'string' ? text : ''
    const cut = source.search(/<tool_result[\s>]/)                       // 模型编造的工具结果：从这里往后全丢。
    const body = cut >= 0 ? source.slice(0, cut) : source
    const found: { call: ToolCall; start: number }[] = []
    const ranges: [number, number][] = []                                 // 已被认领的文字范围，防止两种写法重复认领同一段。
    const taken = (index: number) => ranges.some(([start, end]) => index >= start && index < end)
    const add = (toolName: string, input: unknown, start: number, end: number, invalid?: string) => {
        found.push({ call: { toolCallId: `call_${nanoid(12)}`, toolName, input, ...(invalid ? { invalid } : {}) }, start })
        ranges.push([start, end])
    }
    // 读一个 JSON 体：工具名和参数可能在几个位置（顶层 / OpenAI 风格的 function / 平铺），按常见程度依次找。
    // whole 为 false：块没闭合（回复被截断）。这时 JSON 必须本身完整，不许 jsonrepair 补——补出来的参数（{"a":1,"b": → b=null）会被当真执行。
    const read = (raw: string, whole = true): { name: string; input: unknown; invalid?: string } | null => {
        if (!raw?.trim()) return null
        const fix = (text: string) => whole ? jsonrepair(text) : text
        const cut = '工具调用没写完（回复可能被 maxTokens 截断），请重新完整地调用'
        // GLM 一类模型的写法：工具名单独一行、后面跟参数 JSON（<tool_call>add\n{"a":1}</tool_call>），先拆成标准形状再读。
        const named = /^\s*([A-Za-z_][\w.-]*)\s*\n\s*(\{[\s\S]*)$/.exec(raw)
        if (named) raw = JSON.stringify({ name: named[1], arguments: named[2] })
        let obj: any
        try { obj = JSON.parse(fix(raw)) } catch {
            const name = /"name"\s*:\s*"([^"]+)"/.exec(raw)?.[1]          // 修不回来：至少把名字抠出来，让模型知道哪次调用坏了。
            return name ? { name, input: {}, invalid: whole ? '工具调用里的 JSON 解析失败' : cut } : null
        }
        if (Array.isArray(obj)) obj = obj[0]                              // 模型偶尔套一层数组。
        if (!obj || typeof obj !== 'object') return null
        const fn = obj.function ?? obj.tool ?? obj
        const name = fn?.name ?? obj.tool_name
        if (!name || typeof name !== 'string') return null
        let args = fn.arguments ?? fn.parameters ?? fn.input ?? fn.args
        if (typeof args === 'string') { try { args = JSON.parse(fix(args)) } catch { return { name, input: {}, invalid: whole ? '工具参数不是合法的 JSON' : cut } } }
        if (args === undefined) { const { name: _n, function: _f, tool: _t, tool_name: _tn, type: _ty, ...rest } = obj; args = rest } // 参数平铺在同一层。
        return { name, input: args && typeof args === 'object' ? args : {} }
    }

    // 1. 主格式。
    for (const match of body.matchAll(/<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/g)) {
        const call = read(match[1]!, match[0].endsWith('</tool_call>'))
        if (call) add(call.name, call.input, match.index!, match.index! + match[0].length, call.invalid)
    }
    // 2. 工具名做标签：子标签是参数，值按 schema 类型还原；没有子标签且只有一个参数时，标签体就是它。
    for (const name of spec.names) {
        const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        for (const match of body.matchAll(new RegExp(`<${safe}>([\\s\\S]*?)<\\/${safe}>`, 'g'))) {
            if (taken(match.index!)) continue
            const types = spec.params[name] ?? {}
            const coerce = (value: string, type?: string): unknown => {
                if (type === 'number' || type === 'integer') { const n = Number(value); return Number.isNaN(n) ? value : n }
                if (type === 'boolean') return value === 'true'
                if (type === 'object' || type === 'array') { try { return JSON.parse(value) } catch { return value } }
                return value
            }
            const input: Record<string, unknown> = {}
            for (const child of match[1]!.matchAll(/<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g)) input[child[1]!] = coerce(child[2]!.trim(), types[child[1]!])
            const keys = Object.keys(types), inner = match[1]!.trim()
            let invalid: string | undefined
            if (!Object.keys(input).length && inner) {
                if (keys.length === 1) input[keys[0]!] = coerce(inner, types[keys[0]!])
                else invalid = '工具参数格式无法识别'
            }
            add(name, input, match.index!, match.index! + match[0].length, invalid)
        }
    }
    // 3. 裸 JSON 代码块，只认已注册的工具名。
    for (const match of body.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) {
        if (taken(match.index!)) continue
        const call = read(match[1]!)
        if (call && spec.names.includes(call.name)) add(call.name, call.input, match.index!, match.index! + match[0].length, call.invalid)
    }

    // 把认出来的调用从正文里删掉（从后往前删，位置才不会错位），再收拾多余空行。
    let cleaned = body
    for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) cleaned = cleaned.slice(0, start) + cleaned.slice(end)
    if (!found.length) return { text: source, calls: [] }
    return {
        text: cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
        calls: found.sort((a, b) => a.start - b.start).map(one => one.call), // 按模型写下的先后顺序，而不是工具表顺序。
    }
}
