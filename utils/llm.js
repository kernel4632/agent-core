/*
目标被调用形式（绝对不可修改）：
const result = await LLM.chat({
    // --- 连接（每次传，或初始化配置后省略）---
    baseURL: "https://中转站/v1",
    apiKey: "sk-xxx",
    model: "model-name",
    protocol: "chat",//模型协议，responses、anthropic……，默认chat
    messages: [...],                // 必填
    system,

    // --- 工具（可选）---
    tools: [...],
    toolChoice: "auto",             // auto 让模型自己决定要不要调工具，required 强制每轮都调
    // --- 流式与回调 ---
    stream: true,
    onLLMEvent: event => {},        // 流式时原样接收 AI SDK 的每个事件
    // --- 控制信号 ---
    signal: abortSignal,            // 取消信号，外部随时能打断
    // --- 提示词缓存（可选，默认关闭）---
    cache: false,                   // 只有 OpenAI 官方接口认这组字段，中转站大多会因此 400
    // --- 自定义请求头或请求体 ---
    options: {
    headers: {},                    // 额外请求头
    body: {},                        // 额外请求体
    }
});

这个文件是整个项目与模型供应商之间唯一的边界：
要么返回一份完整结果，要么把供应商给的原始错误原样抛出去。
"这次回答是不是其实失败了"不会流到上层，所以 Loop 和 Retry 都不需要再判断一遍。
 */

import { generateText, streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'

const chat = async ({
    baseURL, apiKey, model, protocol = 'chat', system, messages, tools, toolChoice = 'auto', temperature, stream = true, cache = false, onLLMEvent, signal, options = {},
}) => {
    // --- 检查输入 ---
    if (!baseURL || !model || !Array.isArray(messages)) throw new TypeError('baseURL, model and messages are required') // 没有地址、模型或消息就无法请求。

    // --- 从 messages 中取出系统提示词 ---
    const systemMessage = messages.find(message => message.role === 'system') // Context 可能已经把 system 放进 messages。
    const modelMessages = messages.filter(message => message.role !== 'system') // AI SDK 的 system 单独传入，不重复放进消息列表。
    system ||= systemMessage?.content // 调用方单独传入的 system 优先级更高。

    // --- 根据协议创建 AI SDK 模型 ---
    const settings = { apiKey, baseURL, headers: options.headers } // 所有 Provider 都需要的连接配置。

    // 提示词缓存默认关闭：prompt_cache_key 是 OpenAI 私有字段，中转站和自建网关大多直接 400
    // （实测 gpt-oss-120b 返回 property 'prompt_cache_key' is unsupported，一个请求都发不出去）。
    const stableKey = `agent:${baseURL}:${model}:${Bun.hash(JSON.stringify(system || ''))}` // 相同模型和 system 使用相同缓存键。
    const cacheBody = cache && ['chat', 'responses'].includes(protocol) ? { prompt_cache_key: stableKey, prompt_cache_retention: '24h' } : {} // 只有 OpenAI 风格协议支持这组缓存字段。
    const bodyOverrides = { ...cacheBody, ...options.body } // 用户自定义 body 可以覆盖默认缓存字段。

    // 用户需要覆盖请求体时，拦截 AI SDK 的 fetch，把字段合并进最终 JSON。
    if (Object.keys(bodyOverrides).length) {
        settings.fetch = async (input, init) => {
            let body = init?.body // AI SDK 通常把请求体作为 JSON 字符串传进来。
            if (typeof body === 'string') {
                try {
                    body = { ...JSON.parse(body), ...bodyOverrides } // 保留 AI SDK 字段，再覆盖用户指定字段。
                } catch (error) {
                    throw new TypeError('AI SDK request body is not valid JSON', { cause: error }) // 无法解析时给出明确错误。
                }
            }
            return fetch(input, { ...init, body: body && JSON.stringify(body) }) // 重新编码后发给供应商。
        }
    }

    let providerModel // 不同 protocol 使用不同 Provider，但最后都变成 AI SDK model。
    if (protocol === 'chat') providerModel = createOpenAICompatible({ ...settings, name: 'agent' }).chatModel(model) // OpenAI Chat 兼容接口，适合中转站。
    if (protocol === 'responses') providerModel = createOpenAI(settings).responses(model) // OpenAI Responses 接口。
    if (protocol === 'anthropic') providerModel = createAnthropic(settings).languageModel(model) // Anthropic 接口。
    if (protocol === 'gemini') providerModel = createGoogle(settings).languageModel(model) // Google Gemini 接口。
    if (!providerModel) throw new Error(`Unsupported protocol: ${protocol}`) // 防止拼错协议后静默失败。

    // --- 组织一次统一的 AI SDK 请求 ---
    // maxRetries: 0 —— 重试在这个项目里只有 Retry 一个实现。交给 AI SDK 自己重试会导致
    // 一次 onLLMStart 对应服务端三次请求，而且原始错误会被包成 AI_RetryError，Retry 认不出来。
    const input = { model: providerModel, system, messages: modelMessages, tools, toolChoice, temperature, abortSignal: signal, maxRetries: 0 } // 流式和非流式共用这份参数。

    // --- 非流式请求：等待模型完整返回 ---
    if (!stream) {
        const result = await generateText(input) // 非流式模式直接等待完整结果，供应商错误会直接抛出来。
        return {
            text: await result.text, // 模型最后生成的文字。
            toolCalls: await result.toolCalls, // 模型要求执行的工具调用。
            finishReason: await result.finishReason, // 模型停止生成的原因。
            usage: await result.usage, // 本次请求消耗的 Token。
            warnings: await result.warnings, // Provider 对请求参数的提示。
            responseMessages: await result.responseMessages, // 保存完整 assistant/tool 消息。
        }
    }

    // --- 流式请求：逐个转发事件，再等待最终结果 ---
    const result = streamText(input) // 开始流式请求；真正的事件从 result.stream 产生。
    const text = [] // 单独收集文字，兼容部分 Provider 的事件字段差异。
    let failure = null // 供应商在流中途报的错。

    for await (const event of result.stream) {
        await onLLMEvent?.(event) // 不过滤事件，文字、思考、工具和错误都交给上层。
        if (event.type === 'error') failure = event.error // AI SDK 只对"中断流的网络错误"抛异常，供应商自己报的错是一个事件，不接住就会被当成正常回答。
        if (event.type === 'text-delta') text.push(event.textDelta ?? event.text ?? event.delta ?? '') // 收集最终文字。
    }

    // 把错误原样抛出去：它带着 statusCode 和 isRetryable，Retry 直接就能用。
    // 先于 result.finishReason 抛，避免被 AI SDK 换成丢失了这些字段的 AI_NoOutputGeneratedError。
    if (failure) throw failure

    const finishReason = await result.finishReason
    if (finishReason === 'error') throw new Error('模型请求失败：供应商返回了错误但没有给出原因') // 只有 finishReason 报错、没有 error 事件时的兜底，不让失败伪装成成功。

    return {
        text: text.join('') || await result.text, // 优先使用事件收集的文字，没有则使用 AI SDK 最终文字。
        toolCalls: await result.toolCalls,
        finishReason,
        usage: await result.usage,
        warnings: await result.warnings,
        responseMessages: await result.responseMessages,
    }
}

export default { chat }
