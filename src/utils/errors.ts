/*
错误分类：给每个抛出去的模型 / 网络错误贴一个稳定的 kind，宿主和重试都按它分支。

调用示例：
    const kind = classify(error, timeoutSignal)   // 'auth' | 'limit' | 'overflow' | ...
    throw cancelled()                             // 用户 stop()：AbortError + kind 'aborted'

为什么"上下文超长"也在这里：它是一种分类（kind = 'overflow'），重试见到它不重试，
loop 见到它就强制压缩一次再重发——两边用同一份判据，判据只写一处。
问模型出错时写进 history 的那条记录（explain）也在这里：它只是把分类结果写成给人看的话，loop 的主请求和压缩请求都要用。
宿主回调出错的处理（tell）也放在这里：它回答的是"宿主代码出错了怎么办"，loop / model / tools / retry 都要用，
只能放在最底层的 utils 里，规则只写一处。
本文件不导入任何东西，处在依赖图最底层；不持有任何模块级可变状态（正则是常量）。
*/

import type { ErrorKind } from '../types.ts'

// 通用的"上下文超长"措辞（照抄 Roo Code 的判据，大小写不敏感）：400 + 长度 / 窗口字样。
const OVERFLOW_GENERAL = /context length|window|maximum context|(input )?tokens? exceed|too many tokens/i
// Anthropic 家族特有的措辞，和状态码无关。
const OVERFLOW_ANTHROPIC = /prompt is too long|maximum.*tokens|context.*too.*long|exceeds.*context|token.*limit|context_length_exceeded|max_tokens_to_sample/i

/*
classify：判断一个错误属于哪一类，并把 kind 写回错误对象上（已经有 kind 的不重复判断）。

判断顺序（先具体后笼统）：
1. 我们自己的限时信号已触发 → 'timeout'（避免被误当成用户取消）；
2. AbortError → 'aborted'；
3. 上下文超长（见上面两条正则、或 LengthFinishReasonError）→ 'overflow'；
4. 没有状态码：AI SDK 自己的校验错误 → 'unknown'，其余 → 'network'；
5. 按状态码：401/403 → 'auth'，429 → 'limit'，408 → 'timeout'，5xx → 'server'，其它 4xx → 'request'；
6. 兜底 'unknown'（服务说成功但内容对不上格式，不能算调用方传错）。

返回分出来的 kind，方便调用方直接 switch。
*/
export function classify(error: unknown, timeout?: AbortSignal | null): ErrorKind {
    const target = (error ?? {}) as Record<string, any>                  // 错误可能是任意值；按对象读字段，读不到就是 undefined。
    if (typeof target.kind === 'string') return target.kind as ErrorKind  // 已经分过类（例如重试前贴过），不重复判断。
    const status = target.statusCode ?? target.status                     // AI SDK 用 statusCode，个别库用 status。
    const name = typeof target.name === 'string' ? target.name : ''
    // 把错误可能藏信息的几处文字拼起来：message、responseBody、data、cause；对象尽量取 message，再退一步序列化。
    const texts: string[] = []
    for (const value of [target.message, target.responseBody, target.data, target.cause]) {
        if (typeof value === 'string' && value) texts.push(value)
        else if (value && typeof value === 'object') {
            if (typeof value.message === 'string') texts.push(value.message)
            try { texts.push(JSON.stringify(value)) } catch { /* 循环引用：跳过这一处来源，不影响其它 */ }
        }
    }
    const text = texts.join('\n')
    let kind: ErrorKind
    if (timeout?.aborted) kind = 'timeout'                                                      // 我们自己的限时先判，避免被当成用户取消。
    else if (name === 'AbortError' || target.code === 'ABORT_ERR') kind = 'aborted'              // 用户 stop() 或外部取消。
    else if ((status === 400 && OVERFLOW_GENERAL.test(text)) || OVERFLOW_ANTHROPIC.test(text) || name === 'LengthFinishReasonError') kind = 'overflow' // 上下文超长：交给 loop 压缩后重发。
    else if (name === 'AI_TypeValidationError' || name === 'AI_NoObjectGeneratedError') kind = 'unknown' // 连上了、状态码也成功，只是内容对不上格式。
    else if (status === undefined) kind = name.startsWith('AI_') && name !== 'AI_APICallError' ? 'unknown' : 'network' // AI SDK 本地校验错误没发出请求，不算网络问题。
    else if (status === 401 || status === 403) kind = 'auth'
    else if (status === 429) kind = 'limit'
    else if (status === 408) kind = 'timeout'
    else if (status >= 500) kind = 'server'
    else if (status >= 400) kind = 'request'                                                     // 其它 4xx：参数、格式问题。
    else kind = 'unknown'                                                                        // 2xx 但内容对不上：不能算调用方传错。
    // 能写就把 kind 贴回错误对象：宿主 catch 到的就是带 kind 的原始错误。冻结对象、原始值写不进去，只返回结果。
    if (error && typeof error === 'object' && Object.isExtensible(error)) (error as Record<string, unknown>).kind = kind
    return kind
}

// kind 的中文说法：写进 history 的错误记录给人看。
const LABEL: Record<ErrorKind, string> = { aborted: '已取消', auth: '鉴权失败', limit: '被限流', timeout: '超时', server: '服务端出错', network: '网络出错', request: '请求被拒', overflow: '上下文超长', unknown: '未知错误' }

/*
explain：把一次问模型的错误写成 history 草稿（role:'error'），loop 在每次重试前和最终失败时交给 history.append。
- content 给人看：分类、状态码、服务端原话（取不到就用错误的 message）；不写第几次——同一个错误重试多少次内容都一样，append 才能去重；
- request 存结构化信息：kind、statusCode，加上调用方给的 model / protocol / attempt / compact 等；
- 用户取消（kind 'aborted'）返回 null：那是操作，不是故障，不记。
本函数只拼数据，不碰 history（写 history 的只有 loop）。
*/
export function explain(error: unknown, info: Record<string, unknown> = {}): { role: 'error'; content: string; request: Record<string, unknown> } | null {
    const kind = classify(error)
    if (kind === 'aborted') return null
    const target = (error ?? {}) as Record<string, any>
    const status = target.statusCode ?? target.status
    const said = target.data?.error?.message ?? target.data?.message ?? target.message ?? String(error) // 服务端原话最具体。
    const content = `模型请求出错（${LABEL[kind]}${status ? `，HTTP ${status}` : ''}）：${String(said).slice(0, 1000)}`
    return { role: 'error', content, request: { kind, ...(status ? { statusCode: status } : {}), ...info } }
}

/*
cancelled：造一个"已取消"错误。整个项目只在这里造，名字（AbortError）、kind（'aborted'）和措辞不会漂移。
stop() 打断运行时，send / compact 的 Promise 以它拒绝。
*/
export function cancelled(): Error {
    // DOMException 的 name 就是 AbortError，和 fetch / AbortSignal 的取消错误同一种形状，宿主现有的判断都认。
    return Object.assign(new DOMException('Agent aborted', 'AbortError'), { kind: 'aborted' as const })
}

/*
tell：调一个宿主回调，宿主代码出错（同步抛错或返回的 Promise 被拒绝）都吞掉，不打断循环 / 请求 / 工具。

- 返回一个永不拒绝的 Promise：需要等宿主做完的地方（onStep：宿主在这里持久化这一轮；onToolCall：工具开跑前先让界面显示）就 await；
- 高频的通知（onChunk、onToolOutput、onRetry、onWarning）不 await，写成 void tell(...)——等它就等于给模型输出加了节流阀；
- 不 await 也安全：拒绝在这里被 catch 住，不会变成未处理拒绝（Bun 对未处理拒绝会直接退出宿主进程，旧实现 issue #26）。
*/
export async function tell<T>(callback: ((value: T) => unknown) | undefined, value: T): Promise<void> {
    try { await callback?.(value) } catch { /* 宿主回调出错不影响核心 */ }
}
