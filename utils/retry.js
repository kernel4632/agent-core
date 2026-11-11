/*
目标被调用形式（绝对不可修改）：
const result = await Retry.run({
    // 要重试的操作（一个返回 Promise 的函数）
    operation: () => LLM.chat({ baseURL, model, messages, tools }),

    // 取消信号，用户点停止时触发
    signal: abortSignal,

    // 重试通知回调，UI 靠它显示"正在重试"
    onRetry: (info) => {},

    // 第一次退避基数（毫秒），默认 5000（照抄 Roo Code 的 5 秒），后续按 ×2 递增
    baseDelay: 5000,

    // 单次退避上限（毫秒），默认 600000（照抄 Roo Code 的 600 秒封顶）
    maxDelay: 600000,

    // 一直失败最多再试多久（毫秒），默认不限（Roo 没有总上限）
    maxElapsed: Infinity,

    // 调用方过滤不想重试的错误；函数或 { skipCodes, skipText, skipKinds, shouldRetry }
    retry: undefined,
})
*/

import pRetry from 'p-retry'
import Notify from './notify.js'                 // 重试通知统一从这里调用，出错不影响重试。
import isContextWindowError from './context-error.js' // 上下文超长不在这一层重试，交给 Loop 压缩后重发。

// 取消不是失败，永远不重试。三种形状都认，和项目其它地方的取消标记保持一致。
const isAbort = error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.kind === 'aborted'

// 调用方过滤：返回 true 表示"这个错误不要重试"。
// 支持两种写法——函数直接对错误下判断；对象则命中任一 skip 维度、或 shouldRetry 返回 false 即停手。
// 导出给 Loop 用：auto 降级要把"工具被接口拒收"并进这套过滤，判据只写一处。
const declines = (retry, error) => {
    if (!retry) return false
    if (typeof retry === 'function') return retry(error) === false
    if (typeof retry.shouldRetry === 'function' && retry.shouldRetry(error) === false) return true
    if (Array.isArray(retry.skipCodes) && retry.skipCodes.includes(error?.statusCode)) return true
    if (Array.isArray(retry.skipKinds) && retry.skipKinds.includes(error?.kind)) return true
    if (retry.skipText) {
        const text = `${error?.message ?? ''} ${error?.responseBody ?? ''}`                 // 过滤只在这两处文字上找，够常用。
        const hit = retry.skipText instanceof RegExp ? retry.skipText.test(text) : text.includes(String(retry.skipText))
        if (hit) return true
    }
    return false
}

// --- 决策顺序照抄 Roo Code ---
// 1. 取消 → 不重试；2. 上下文超长 → 不在这里重试（抛上去由 Loop 压缩后重发）；
// 3. 调用方过滤说停 → 不重试；4. 次数/总时长到顶 → 不重试；5. 其余一律重试。
const shouldRetry = (error, retry) => {
    if (isAbort(error)) return false
    if (isContextWindowError(error)) return false
    if (declines(retry, error)) return false
    return true
}

const run = async ({ operation, signal, onRetry, baseDelay = 5000, maxDelay = 600000, maxElapsed = Infinity, maxTries = Infinity, retry }) => {
    // 次数上界有两条：maxTries（最多重试几次）和 maxElapsed（最多再试多久），谁先到谁收手。
    // 默认都是 Infinity（一直重试直到被取消、上下文超长，或调用方过滤）；maxTries: 0 表示一次都不重试。
    // 退避用 p-retry 的指数公式：min(round(base × 2^(n-1)), maxDelay)，正好是 5、10、20…直到封顶。
    const options = {
        retries: maxTries,                        // p-retry 的 retries 就是"再重试几次"，Infinity＝不限。
        signal,                                   // p-retry 会在请求之间和等待期间响应用户取消。
        minTimeout: baseDelay,                    // 第一次等待的基数（默认 5000ms）。
        factor: 2,                                // 后续每次等待翻倍。
        maxRetryTime: maxElapsed,                 // 一直失败最多再试多久；Infinity 表示不限。
        shouldRetry: async ({ error, attemptNumber, retryDelay }) => {
            if (!shouldRetry(error, retry)) return false // 取消、上下文超长、调用方过滤都立刻收手，把原始错误交给上层。
            await Notify.tell(onRetry, { attempt: attemptNumber, maxTries, error, delay: retryDelay }) // 让上层能显示"正在重试第几次 / 最多几次"。
            return true
        },
    }
    if (Number.isFinite(maxDelay)) options.maxTimeout = maxDelay // 只有给出有限上限时才封顶单次等待（毫秒）。
    return pRetry(operation, options) // 交回重试库执行，结果或错误原样向上传。
}

export default { run, declines }
