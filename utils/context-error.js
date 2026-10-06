/*
判断一个错误是不是"上下文超长"。

干什么：给两个边界提供同一个判据——Retry 见到它就不在这里重试（交给 Loop 压缩后重发），
Loop 见到它就走"强制压缩一次，再重发这笔请求"的专项流程。
为什么单独成文件：这个判据要被 utils/retry.js 和 features/loop.js 共用，
但判定本身不认识任何 feature，放这里不会制造循环依赖。

判定规则照抄 Roo Code 的 checkContextWindowExceededError（大小写不敏感）：
- 400 且报错信息提到上下文长度或窗口；
- 错误 name 是 LengthFinishReasonError；
- Anthropic 家族特有的几种措辞。
*/

// Roo 的通用判据：先说长度，再说窗口，以及"token 超出""token 太多"。
const GENERAL = /context length|window|maximum context|(input )?tokens? exceed|too many tokens/i
// Anthropic 家族（Claude）的报错措辞。
const ANTHROPIC = /prompt is too long|maximum.*tokens|context.*too.*long|exceeds.*context|token.*limit|context_length_exceeded|max_tokens_to_sample/i

// 把错误可能藏信息的几处文字收集起来：message、responseBody、data.error.message、cause。
// 有些字段是对象，尽量取出它的 message，再退一步序列化，保证不因为拿不到字符串而漏判。
const textOf = error => {
    const parts = []
    const add = value => {
        if (typeof value === 'string') { if (value) parts.push(value); return }
        if (value && typeof value === 'object') {
            if (typeof value.message === 'string') parts.push(value.message)
            try { parts.push(JSON.stringify(value)) } catch { /* 循环引用等序列化失败就跳过，不影响其它来源。 */ }
        }
    }
    add(error?.message)
    add(error?.responseBody)
    add(error?.data)
    add(error?.cause)
    return parts.join('\n')
}

const isContextWindowError = error => {
    if (!error) return false
    const status = error.statusCode ?? error.status
    const text = textOf(error)
    if (status === 400 && GENERAL.test(text)) return true // 通用：400 + 长度/窗口字样。
    if (ANTHROPIC.test(text)) return true                 // Anthropic 的措辞与状态码无关。
    if (error.name === 'LengthFinishReasonError') return true // 停止原因就是长度用尽。
    return false
}

export default isContextWindowError
