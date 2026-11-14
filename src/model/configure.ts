/*
configure：把"统一请求数据"翻译成 AI SDK generateText / streamText 的调用参数。

调用示例（在 model/ask 里）：
    const call = configure(request, system, messages, hasTools)   // { model, system, messages, maxOutputTokens, output, toolChoice?, ... }

翻译内容：
- 连接：model 是字符串时按 protocol 选 provider 现连（chat → openai-compatible，responses → openai，
  anthropic → anthropic，gemini → google），用 baseURL / apiKey；是模型实例就原样用（保留宿主自定义的中间件）；
- 生成参数：provider 里的字段原样展开（temperature 等）；headers / body 两个是连接参数，单独取出；
  maxTokens → maxOutputTokens，provider 里显式写的 maxOutputTokens 优先；
  这一笔不发原生工具时（没有工具、文字工具模式、压缩请求）去掉 toolChoice：它只对工具有意义，
  单独发出去部分服务商会拒收，'required' 还会让 AI SDK 因"没调工具"把正常回答判成错误；
- includeUsage（默认 true）：chat 协议流式时请求 usage，token 校准靠它；个别不认 stream_options 的中转站设 false；
- 提示词缓存（默认开启，实测数据见下）：
    chat / responses：服务端按 prompt_cache_key 路由到同一处缓存。不发 0%，发了第二步起 99%；
    anthropic：服务端不自动缓存，必须在内容块上标 cache_control（system 一个、最后一条消息一个），与宿主已有的 providerOptions 合并；
    gemini：隐式缓存由服务端决定，请求里没有可发的字段；
- 结构化输出：output 有值就挂上 AI SDK 的 output 参数，没值就不挂（不需要单独开关）；
- responses：assistant 文字块不发 item_reference，发全文（请求自包含，见下面的注释）；reasoning 为 'send' 时
  关 store、请求 reasoning.encrypted_content，思考也发全文；
- maxRetries 固定为 0：重试在这个项目里只有 utils/retry 一个实现，交给 AI SDK 会一次请求变三次、错误被包成 AI_RetryError。

configure 只做翻译，不发请求、不重试、不处理文字工具（那些在 ask 里）。
没有模块级可变状态：provider 实例每次现建，构造成本可以忽略，换 baseURL / apiKey 也立即生效。
*/

import type { LanguageModel, ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import type { AskRequest } from '../types.ts'

// Anthropic 的缓存断点：挂在 providerOptions 上，AI SDK 会翻译成 cache_control。system 和最后一个内容块各用一次。
const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } }

/*
configure：按文件头的规则把 request（以及 ask 处理过文字工具之后的 system / messages）翻译成调用参数。
返回的对象直接展开交给 generateText / streamText，ask 再补上 tools、abortSignal；hasTools 说明这一笔会不会带原生工具。
model 是字符串但缺 baseURL 时抛 TypeError（说明要么给地址，要么直接传模型实例）。
*/
export function configure(request: AskRequest, system: string | undefined, messages: ModelMessage[], hasTools: boolean): Record<string, unknown> & { model: LanguageModel } {
    const { model, baseURL, apiKey, protocol = 'chat', provider = {}, maxTokens, output } = request
    if (!model || !Array.isArray(messages)) throw new TypeError('model and messages are required')
    if (typeof model === 'string' && !baseURL) throw new TypeError('string models need baseURL; or pass an AI SDK model instance')
    const { headers, body, toolChoice, ...generation } = provider as { headers?: Record<string, string>; body?: Record<string, unknown> } & Record<string, unknown>
    // 模型实例的连接归创建者管：这个包换不了它的 fetch，所以默认缓存对实例安静跳过。
    const cache = typeof model === 'string' ? request.cache ?? true : false

    let languageModel: LanguageModel
    if (typeof model !== 'string') languageModel = model
    else {
        // 缓存键只取"这段对话从哪开始"：同一个 Agent 的连续请求开头相同，自然落在同一个键上。
        // 哈希的写法和旧实现一致（JSON.stringify 之后再 hash），升级前后同一段对话落在同一个键上，缓存不白丢。
        const cacheOptions = typeof cache === 'object' ? cache : {}
        const cacheBody = cache && (protocol === 'chat' || protocol === 'responses')
            ? { prompt_cache_key: cacheOptions.key ?? `agent:${baseURL}:${model}:${Bun.hash(JSON.stringify(system || ''))}`, ...(cacheOptions.retention ? { prompt_cache_retention: cacheOptions.retention } : {}) }
            : {}
        const extraBody = { ...cacheBody, ...(cache ? cacheOptions.body : {}), ...body } // 宿主的 body 可以覆盖默认缓存字段。
        // 只有自建的连接才能接管 fetch：把额外字段并进 AI SDK 已经组好的请求体，请求头、方法、取消信号原样保留。
        const fetcher = Object.keys(extraBody).length ? (async (input: string | URL | Request, init?: RequestInit) => {
            const raw = init?.body
            const merged = typeof raw === 'string' ? JSON.stringify({ ...JSON.parse(raw), ...extraBody }) : raw
            return fetch(input, { ...init, body: merged })
        }) as typeof fetch : undefined
        const settings = { baseURL, apiKey, headers, fetch: fetcher }
        if (protocol === 'chat') languageModel = createOpenAICompatible({ ...settings, baseURL: baseURL!, name: 'agent', includeUsage: request.includeUsage ?? true, supportsStructuredOutputs: Boolean(output) }).chatModel(model) // includeUsage：流式也带 usage，token 校准靠它；宿主可关。
        else if (protocol === 'responses') languageModel = createOpenAI(settings).responses(model)
        else if (protocol === 'anthropic') languageModel = createAnthropic(settings).languageModel(model)
        else if (protocol === 'gemini') languageModel = createGoogle(settings).languageModel(model)
        else throw new TypeError(`Unsupported protocol: ${protocol}`)       // 协议拼错时在源头报错。
    }

    // Anthropic 缓存：给 system 和最后一条消息的最后一个内容块打断点（纯文本消息先摊成一个文字块才有地方挂）；
    // 合并进内容块已有的 providerOptions.anthropic（例如宿主写的别的选项），不覆盖。
    const anthropicCache = cache && protocol === 'anthropic'
    let sentMessages = messages
    if (anthropicCache && messages.length) {
        const last = messages.at(-1)!
        const content = (Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }]) as Record<string, any>[]
        if (content.length) sentMessages = [...messages.slice(0, -1), { ...last, content: [...content.slice(0, -1), { ...content.at(-1), providerOptions: { ...content.at(-1)!.providerOptions, anthropic: { ...content.at(-1)!.providerOptions?.anthropic, ...EPHEMERAL.anthropic } } }] } as ModelMessage]
    }
    // responses：上一次回复的文字块带着 itemId，AI SDK 见到就只发 item_reference（指向服务端存档）而不是全文。
    // 请求必须自包含——history 才是事实来源，换 key / 中转站 / 存档过期后引用都会失效（实测中转站直接 400 拒收，默认重试还会卡死）。
    // 只去掉 itemId，文字原样发出；思考块（reasoning: 'send'）不动。
    if (protocol === 'responses') sentMessages = sentMessages.map(message => message.role !== 'assistant' || !Array.isArray(message.content) ? message
        : { ...message, content: (message.content as Record<string, any>[]).map(part => part.type === 'text' && part.providerOptions?.openai?.itemId ? { ...part, providerOptions: { ...part.providerOptions, openai: { ...part.providerOptions.openai, itemId: undefined } } } : part) } as ModelMessage)
    const sentSystem = anthropicCache && system ? { role: 'system' as const, content: system, providerOptions: EPHEMERAL } : system

    // responses + reasoning 'send'：思考要发全文才能原样带回。按 AI SDK 的做法关掉 store、请求 reasoning.encrypted_content，
    // 加密的思考随回复进 history，下次作为完整的 reasoning 条目发出，而不是 item_reference。宿主在 providerOptions.openai 里显式写的优先。
    const host = generation.providerOptions as Record<string, Record<string, any>> | undefined
    const providerOptions = protocol === 'responses' && request.reasoning === 'send'
        ? { ...host, openai: { store: false, ...host?.openai, include: [...new Set([...(host?.openai?.include ?? []), 'reasoning.encrypted_content'])] } }
        : host
    return {
        ...generation,
        ...(providerOptions ? { providerOptions } : {}),                                                    // 宿主的生成参数整包展开，不逐个列字段。
        model: languageModel,
        system: sentSystem,
        messages: sentMessages,
        maxRetries: 0,
        // 已建好的模型实例：额外请求头按请求级参数发送（自建连接已经在 settings 里带上了）。
        ...(typeof model !== 'string' && headers ? { headers } : {}),
        ...(maxTokens !== undefined && generation.maxOutputTokens === undefined ? { maxOutputTokens: maxTokens } : {}),
        ...(output ? { output } : {}),
        ...(hasTools && toolChoice !== undefined ? { toolChoice } : {}),     // 只有真的带工具时才发 toolChoice。
    }
}
