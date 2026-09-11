/*
目标被调用形式（绝对不可修改）：
const result = await Retry.run({
    // 要重试的操作（一个返回 Promise 的函数）
    operation: () => LLM.chat({ messages, tools }),

    // 取消信号，用户点停止时触发
    signal: abortSignal,

    // 重试通知回调，UI 靠它显示"正在重试"
    onRetry: (info) => {},

    // 重试退避时间上限，默认 60 秒
    maxDelay: 60,
})
 */

import pRetry from 'p-retry'

// "这个错误能不能重试"由抛错的人说了算：LLM.chat 抛的是 AI SDK 的原始 APICallError，
// 它自己带着 isRetryable（429、408、5xx、连接失败都为真）。这里不再照着状态码重新判断一遍，
// 否则同一件事会有两套标准，而且一旦 AI SDK 换了错误形状，这里就会静默失效。
const isRetryable = error => {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return false // 用户主动取消不是失败，不该重试。
    return error?.isRetryable === true
}

const run = async ({ operation, signal, onRetry, maxDelay = 60 }) => {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function')
    if (!Number.isFinite(maxDelay) || maxDelay < 0) throw new TypeError('maxDelay must be a non-negative number')

    return pRetry(operation, {
        retries: Infinity, // 文件头没有最大次数参数，保持原先“可重试就持续重试”的约定。
        signal, // p-retry 会在请求之间和等待期间响应用户取消。
        minTimeout: 1000, // 第一次等待一秒，后续自动按指数增长。
        maxTimeout: maxDelay * 1000, // 文件头的秒单位转换为 p-retry 使用的毫秒。
        shouldRetry: async info => {
            const retry = isRetryable(info.error)
            if (retry) await onRetry?.({ attempt: info.attemptNumber, error: info.error, delay: info.retryDelay })
            return retry
        },
    })
}

export default { run }
