/*
History 只创建“通用历史块”，不保存任何供应商专用字段。
发给模型前的整理由本文件的 model() 完成：去掉 id、compact 等内部字段，只留 role 和 content，
并按能力开关转换媒体块。Context.build() 和 LLM.chat 都调用它，规则只有这一份。

// 1. 创建用户历史块
const userMessage = History.user({ content: '帮我写个爬虫' })
// 结果：{ id, role: 'user', content: '帮我写个爬虫' }

// 2. 创建 assistant 历史块
const assistantMessage = History.assistant({
    content: '好的',              // 普通文字；也可以传内容块数组
    toolCalls: [{                 // 可选，模型需要调用工具时传入
        id: 'call-1',
        name: 'finish',
        arguments: { result: '完成' }, // 支持对象，也支持 JSON 字符串
    }],
})

// 3. 创建工具结果历史块
const toolMessage = History.tool({
    toolCallId: 'call-1',
    toolName: 'finish',
    content: '工具执行结果',
})

// 4. 创建压缩总结历史块
const compactMessage = History.compact({ content: '之前的对话总结...' })

// 5. 需要完整内容块时，直接传 AI SDK 风格的 content 数组
const detailedMessage = History.assistant({
    content: [
        { type: 'reasoning', text: '我需要先调用工具。' },
        { type: 'text', text: '我先处理一下。' },
    ],
})
*/

import { nanoid } from 'nanoid'

// 统一检查字符串，避免历史里出现空的身份或内容。
const text = (value, name) => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
    return value
}

// 每个历史块都有自己的 id；调用方传 id 时保留它，方便前端定位和更新消息。
const messageId = id => text(id ?? nanoid(), 'id')

// 字符串是最简单的写法；数组则原样保留 AI SDK 风格的内容块。
// allowEmpty 只给 assistant 用：它可以只调工具、不写字（content 为 null）。
const contentParts = (content, name = 'content', allowEmpty = false) => {
    if (Array.isArray(content)) return content                       // 已经是内容块数组，原样用。
    if (content === null && allowEmpty) return []                    // 允许空内容的调用方（assistant），空就是没有内容块。
    return [{ type: 'text', text: text(content, name) }]             // 一句纯文本，包成一个文字块。
}

// 工具参数可以是对象，也可以是 OpenAI 格式的 JSON 字符串。
// 从库里恢复的会话可能带着没写完的字符串；读不出来就当没有参数，不让一条坏记录打死整个会话。
const toolInput = raw => {
    if (typeof raw !== 'string') return raw
    try { return JSON.parse(raw) } catch { return {} }
}

// 创建用户历史块；Context.build() 最终会只取 role 和 content。
// content 既可以是一段纯文本，也可以是 AI SDK 风格的内容块数组——图片和文件就走数组这条路
// （AI SDK 的 UserContent 本来就是 string | Array<TextPart | ImagePart | FilePart>）。
const user = ({ id, content }) => {
    if (Array.isArray(content) && !content.length) throw new TypeError('content must not be an empty array') // 空消息会被供应商拒收。
    return { id: messageId(id), role: 'user', content: Array.isArray(content) ? content : text(content, 'content') } // 纯文本直接存，内容块原样存。
}

// 创建 assistant 历史块；内容块和工具调用最终都放在同一个 content 数组里。
const assistant = ({ id, content = null, toolCalls = [] }) => ({
    id: messageId(id),                                          // 每条消息一个 id，前端靠它定位和更新。
    role: 'assistant',                                          // 这是模型说的话。
    content: [
        ...contentParts(content, 'assistant content', true),    // 正文和思考按原样放进 content；允许为空（只调工具时）。
        ...toolCalls.map(({ id: callId, name, arguments: rawArguments, input }) => ({ // 每个工具调用也变成一个内容块。
            type: 'tool-call',                                  // 一次工具调用就是一个内容块。
            toolCallId: text(callId, 'toolCalls[].id'),         // 结果靠这个 id 找回它，不能为空。
            toolName: text(name, 'toolCalls[].name'),           // 调用的工具名。
            input: input ?? toolInput(rawArguments),            // 参数可以是对象，也可以是 JSON 字符串。
        })),
    ],
})

// 创建工具结果历史块；toolCallId 必须和 assistant 的工具调用对应。
const tool = ({ id, toolCallId, toolName, content }) => ({
    id: messageId(id),                                     // 每条消息一个 id。
    role: 'tool',                                          // 这是工具返回的内容。
    content: [{
        type: 'tool-result',                               // 一次工具结果就是一个内容块。
        toolCallId: text(toolCallId, 'toolCallId'),        // 认回它在回答哪一次调用。
        toolName: text(toolName, 'toolName'),              // 哪个工具返回的。
        output: typeof content === 'string' ? { type: 'text', value: text(content, 'content') } : content, // 纯文本包成 text 块，成形的输出块原样保留。
    }],
})

// 创建压缩总结块；它仍然是 user 角色，但 compact 标记让 Context 识别最新总结。
const compact = ({ id, content }) => ({ id: messageId(id), role: 'user', content: text(content, 'content'), compact: true })

// 创建一条只给宿主看的失败记录：模型看不到（Context 会整条丢掉），但能存进 history、刷新后还能渲染。
// request 是宿主自己的审计信息（provider / model / 耗时 / 错误原因……），原样保存，不参与任何模型逻辑。
const error = ({ id, content, request }) => ({
    id: messageId(id),
    role: 'error',
    content: text(content, 'content'),
    ...(request === undefined ? {} : { request }),
})

// --- 把外部来的消息收进历史时补上 id ---
// AI SDK 返回的 assistant 消息没有 id，而 history 里的每条消息都该有 id（前端靠它定位和更新）。
// 所以模型产出在写入 history 之前统一在这里贴一个，其它字段原样保留——包括厂商的思考签名。
const stored = message => ({ ...message, id: message.id ?? nanoid() })


// --- 一条消息的内容块：不管内容是数组还是一句纯文本，都给出块数组 ---
// "消息内容长什么样"这件事只在这里判断一次：纯文本当成一个文字块，
// 需要遍历内容块的地方（认工具调用、降级成纯对话消息、渲染）都调它，不用各自再判一遍。
const parts = message => Array.isArray(message.content)
    ? message.content
    : message.content === undefined || message.content === null ? []
    : [{ type: 'text', text: message.content }]

// --- 这批消息里，哪些工具调用已经拿到了结果 ---
// History.model 会摘掉没人应答的调用（供应商要求调用和结果必须配对）。
// Context 和 LLM.chat 两处都要用这份名单，所以只在这里算一次。
const answeredCalls = messages => new Set(messages.flatMap(message => parts(message).filter(part => part.type === 'tool-result').map(part => part.toolCallId)))


// --- 统一旧媒体块：AI SDK 当前用 file，旧渠道常用 image / audio / video ---
// 历史原样保存，只有发给模型的副本做转换；这样换模型不会破坏数据库里的原始消息。
// AI SDK v7 的 file 块要求 data 是带标签的形状：{type:'data',data} 或 {type:'url',url}，
// 直接给裸字符串会被它在本地拒收（尤其在工具结果里），于是 history 一写进去就永久毒死会话。
const media = (part, value, fallback) => {
    const url = toUrl(value)
    return {
        type: 'file',                              // AI SDK 现在统一用 file 装媒体。
        mediaType: part.mediaType ?? fallback,     // 没写类型时按调用方给的默认值。
        data: url ? { type: 'url', url } : { type: 'data', data: value }, // 网址 / data URL 走 url（要 URL 对象），其余走 data。
        ...(part.filename ? { filename: part.filename } : {}), // 有文件名就带上。
    }
}

// URL 对象 / http(s) 网址 / data URL 才当 URL；解析失败退回 null（免得 new URL 抛错，而这时坏块已写进 history）。
const toUrl = value => {
    if (value instanceof URL) return value
    if (typeof value !== 'string' || !/^(https?:|data:)/i.test(value)) return null
    try { return new URL(value) } catch { return null }
}

// 看一个内容块装的是什么媒体。认不出来返回 null，说明它根本不是媒体块。
const mediaKind = part => {
    if (part.type === 'image' || part.type === 'audio' || part.type === 'video') return part.type // 旧写法：类型直接写在块上。
    if (part.type !== 'file' && part.type !== 'file-data' && part.type !== 'file-url') return null // 不是任何媒体块。
    if (typeof part.mediaType !== 'string') return 'file' // mediaType 不是字符串（畸形输入）就当普通文件，别在 .startsWith 上抛。
    if (part.mediaType === 'image' || part.mediaType.startsWith('image/')) return 'image' // 带斜杠的完整类型和只有顶层段的写法都认。
    if (part.mediaType === 'audio' || part.mediaType.startsWith('audio/')) return 'audio'
    if (part.mediaType === 'video' || part.mediaType.startsWith('video/')) return 'video'
    return 'file'                                  // 认得出是文件，但不是图音视，按普通文件算。
}

// --- 一个内容块要不要发、长什么样 ---
// 三类变化都在这里：摘掉思考、摘掉没人应答的调用、把旧媒体块转成 file。
const preparePart = (part, options) => {
    if (part.type === 'reasoning' && options.reasoning === false) return null // 思考是上一家模型的内部产物，默认不喂给下一家。
    if (part.type === 'tool-call' && !options.answered.has(part.toolCallId)) return null // 没有结果的调用会让很多接口拒绝整段历史。

    const kind = mediaKind(part)                       // 不是媒体块的话，后面几行都不用管。
    if (!kind) return part                             // 普通文字、工具调用、工具结果，原样发出去。
    if (options.capabilities[kind] === false) {        // 调用方说这个模型不支持这种媒体。
        if (options.mediaFallback === 'strip') return null // 不支持媒体时只丢掉媒体，文字和任务仍可继续。
        throw new TypeError(`当前模型未启用 ${kind} 内容；设置 capabilities.${kind}=true，或使用 mediaFallback:'strip'`)
    }
    if (!options.normalizeMedia) return part           // Context 对外只读历史，不在这里改变内容块的公开形状。

    if (part.type === 'image') return media(part, part.image, 'image/png')                    // 旧 image 块 → file 块。
    if (part.type === 'audio') return media(part, part.audio, 'audio/mpeg')                   // 旧 audio 块 → file 块。
    if (part.type === 'video') return media(part, part.video, 'video/mp4')                    // 旧 video 块 → file 块。
    if (part.type === 'file-data') return media(part, part.data, part.mediaType ?? 'application/octet-stream') // 已经是 file 系列，补上默认类型。
    if (part.type === 'file-url') return media(part, part.url ?? part.data, part.mediaType ?? 'application/octet-stream')
    // 已经是 file：分三种。data 带标签且是内联字节 → 原样；data 带标签但里面是网址 / data URL → 改成 url（AI SDK 不接受把它们当内联数据）；data 还是裸值（旧写法）→ 补成带标签的形状。
    if (part.type === 'file') {
        const tagged = part.data && typeof part.data === 'object' && 'type' in part.data && !(part.data instanceof URL)
        if (!tagged) return media(part, part.data ?? part.url, part.mediaType ?? 'application/octet-stream')
        // 带标签的 url / data 都重新交给 media()：它会把字符串网址重新包成 URL 对象（AI SDK 要 URL 对象），
        // data URL 也会挪到 url 分支。不重包的话，jsonSafe 留下的字符串 url 会在这里直接穿过去、被 AI SDK 拒收。
        const inner = part.data.type === 'url' ? part.data.url : part.data.type === 'data' ? part.data.data : undefined
        if (inner === undefined) return part
        return media(part, inner, part.mediaType ?? 'application/octet-stream')
    }
    return part                                        // 到这里只剩不认识的块，原样。 
}

// 工具结果里的内容块也要走同一套规则（结果里可能带图片）。
// 这里强制转换（不管调用方给的 normalizeMedia）：工具结果这个位置只收 AI SDK v7 的带标签 file 块，
// 旧写法（image / file-data / file-url）会直接被 AI SDK 拒收，而结果已经写进只增不删的 history。
const prepareOutput = (output, options) => output?.type !== 'content'
    ? output                                                                                        // 不是多模态结果，原样返回。
    : { ...output, value: output.value.flatMap(part => { const prepared = preparePart(part, { ...options, normalizeMedia: true }); return prepared ? [prepared] : [] }) } // 逐块处理，被摘掉的块丢掉。

// --- 媒体能力开关的默认值，整个项目只有这一处 ---
// Agent 组装完整能力表时从这里取媒体那几项，History.model 单独被调用时也用它，两处永远一致。
export const mediaDefaults = { image: true, audio: true, video: true, file: true }

// --- 兼容规则的默认值 ---
// 从 Agent 来的调用会带上组装好的完整开关；直接调用 History.model 时用这里的默认值，行为一致。
const DEFAULTS = { capabilities: mediaDefaults, reasoning: false, mediaFallback: 'error' }

// Context 和 LLM.chat 都调用这一处，保证用户消息、工具返回的媒体和历史消息使用完全相同的兼容规则。
const model = (message, { answered = new Set(), capabilities = DEFAULTS.capabilities, reasoning = DEFAULTS.reasoning, mediaFallback = DEFAULTS.mediaFallback, normalizeMedia = true } = {}) => {
    const options = { answered, capabilities, reasoning, mediaFallback, normalizeMedia }
    const content = Array.isArray(message.content)
        ? message.content.flatMap(part => {
            const prepared = preparePart(part, options)                    // 这一块要不要发、长什么样的规则都在这里。
            if (!prepared) return []                                       // 被摘掉的块（思考、没人应答的调用、不支持且选择丢掉的媒体）不占位置。
            return prepared.type === 'tool-result' ? [{ ...prepared, output: prepareOutput(prepared.output, options) }] : [prepared] // 工具结果里的媒体也要按同一套规则处理。
        })
        : message.content ?? []                                            // 外部还原的历史可能是 content:null（只调了工具没说话），当成空内容，由 Context 整条丢掉。
    return { role: message.role, content }                                 // 只留角色和内容，id、compact 这些内部字段不带出门。
}


// 模型只认这三种 role；其他（比如宿主的失败记录 role:'error'）属于宿主数据，不参与回合。
export const MODEL_ROLES = new Set(['user', 'assistant', 'tool'])

// --- 把平铺历史折成回合 ---
// 一个回合 = 用户的一次发言，或模型的一次响应连同它发起的全部工具调用与结果。
// 工具结果认的是发起它的 toolCallId，不是它在数组里排在谁后面，所以先把回合拼出来、
// 登记完每个回合欠下的调用，第二趟再统一分配结果——一趟边填边查会退化成"只有排在调用
// 后面的结果才认得出来"，历史被外部乱序拼接或按 id 从库里恢复时，结果会被悄悄丢掉。
//
// 宿主记录（role:'error' 这类模型不消费的消息）不是回合：直接跳过，既不进上下文，也不占预算。
//
// Context 裁剪上下文用它，上层要数"聊了几轮"、"取最近三个来回"也用它。
// 这条规则微妙，不暴露出去的话每个调用方都会自己推一遍，而且大概率推错。
const turns = history => {
    const list = []                                                                  // 回合列表：每个回合是一组永不拆开的消息。
    const caller = new Map()                                                         // toolCallId → 发起它的那个回合，工具结果靠这张表回家。
    let open = null                                                                  // 正在累积的模型响应；遇到工具结果或新的用户消息就收口。

    // --- 第一趟：拼回合，并登记每个回合欠下的工具调用 ---
    for (const message of history) {
        if (!MODEL_ROLES.has(message.role)) continue                                  // 宿主记录不是对话，模型看不到它。
        if (message.role === 'tool') { open = null; continue }                        // 工具结果自己不开回合，但它意味着上一轮响应已经说完了。

        if (message.role === 'assistant' && open) open.push(message)                  // 同一次响应拆成的多条 assistant（思考、文字、调用）属于同一个回合。
        else {
            open = message.role === 'assistant' ? [message] : null                    // user 和总结各自独占一个回合，不接纳后续消息。
            list.push(open ?? [message])
        }

        for (const part of parts(message)) if (part.type === 'tool-call') caller.set(part.toolCallId, list.at(-1)) // 记下这次调用属于哪个回合，结果回来时靠它找家。
    }

    // --- 第二趟：工具结果按 id 回到发起它的回合，跟它排在谁后面完全无关 ---
    for (const message of history) {
        if (message.role !== 'tool') continue
        caller.get(parts(message)[0]?.toolCallId)?.push(message)                      // 找不到发起者的结果不构成任何回合，自然消失。
    }

    return list                                                                       // 每个回合都是一组消息，顺序和时间一致。
}


// 一个工具输出块长什么样是这个包定义的（text / json / content / error-text / …），
// 所以"怎么把它变成一句人能看的话"也该由这个包回答，而不是让每个调用方照着内部结构重写。
const readOutput = output => output?.type === 'content' ? output.value.map(part => part.type === 'text' ? part.text : `[${part.type}]`).join(' ') // 多模态结果：文字照出，媒体标一个类型。
    : typeof output?.value === 'string' ? output.value                                                                                            // 文字结果直接用。
    : JSON.stringify(output?.value ?? output)                                                                                                     // 其余序列化成 JSON 文字。

// 每种内容块显示成什么样。思考和媒体折叠成一个标记，正文原样出。
const readPart = {
    text: part => part.text,                                                              // 正文原样出。
    reasoning: () => '[思考]',                                                            // 思考太啰嗦，折叠成标记。
    'tool-call': part => `[调用 ${part.toolName} ${JSON.stringify(part.input ?? {})}]`,    // 工具调用显示名字和参数。
    'tool-result': part => `[${part.toolName} 返回] ${readOutput(part.output)}`,           // 工具结果显示是哪次、返回了什么。
    image: () => '[图片]',                                                                // 下面四种媒体都折叠成标记。
    file: () => '[文件]',
    audio: () => '[音频]',
    video: () => '[视频]',
}


// --- 把历史渲染成人能读的一段文本 ---
// IM 里回显、UI 里展示、日志里记录"刚才发生了什么"，都要先把内容块摊平成文字。
// 哪些块该显示、哪些该折叠，这份知识本来就在这个文件里；不暴露的话每个嵌入方都要
// 照着内部结构重写一遍，而且会随着内容块类型增加而悄悄过时。
// 想自己排版的，用 turns() 拿回合，再按下面这些块类型自己拼。
const render = history => history
    .map(message => `${message.role}: ${Array.isArray(message.content)
        ? message.content.map(part => (readPart[part.type] ?? (one => `[${one.type}]`))(part)).join(' ') // 每种块交给对应的显示函数，不认识的块显示类型名。
        : message.content}`)                                                                             // 纯文本消息直接出。
    .join('\n')


export default { user, assistant, tool, compact, error, stored, turns, render, model, parts, answeredCalls, mediaDefaults }
