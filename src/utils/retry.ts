/*
重试：模型 / 网络错误由内核重试，次数、总时长、单次超时都由宿主通过 config 配置。

调用示例：
    const reply = await retry(attempt => send(attempt), { maxTries: 3, maxElapsed: 60000, timeout: 30000, signal, onRetry })

规则（照抄 Roo Code 的退避策略）：
- 默认任何错误都重试，除了 kind 为 'aborted'（用户取消）和 'overflow'（上下文超长，交给 loop 压缩后重发）；
- 宿主的 filter 命中时不重试：函数返回 false；或对象里 shouldRetry 返回 false、命中 skipCodes / skipKinds / skipText 任一项；
- 退避从 baseDelay 开始每次 ×2，单次不超过 maxDelay；maxTries 和 maxElapsed 谁先到谁停；
- 每次尝试都套一个 timeout 限时信号；超时的错误由 classify 贴成 'timeout'，照常参与重试；
- signal 一旦取消，正在等的退避立刻结束并抛 cancelled()。

本文件只依赖同目录的 errors.ts；没有模块级可变状态，计数都在一次 retry 调用的局部变量里。
*/

import type { Config, RetryOptions } from '../types.ts'
import { classify, cancelled, tell } from './errors.ts'

// 默认退避基数 5 秒、单次上限 10 分钟（Roo Code 的取值）；次数和总时长默认不限。
export const DEFAULT_BASE_DELAY = 5000
export const DEFAULT_MAX_DELAY = 600000

// 一次尝试拿到的上下文：第几次（从 1 开始），以及这一次专属的限时 + 取消合并信号。
export interface Attempt { attempt: number; signal: AbortSignal }

/*
options：把 config 里平铺的重试字段收拢成 RetryOptions。主请求（loop/run）和压缩请求（loop/compact）都要用，
所以放在这里，规则只写一处。没写的字段保持 undefined，由 retry 补默认值。
*/
export function options(config: Config): RetryOptions {
    return {
        maxTries: config.retryMaxTries ?? undefined,
        maxElapsed: config.retryMaxElapsed,
        baseDelay: config.retryBaseDelay,
        maxDelay: config.retryMaxDelay,
        timeout: config.requestTimeout,
        filter: config.retry,
    }
}

/*
retry：反复执行 fn 直到成功、命中不重试的错误、次数或总时长用尽，或被取消。

- fn 每次收到新的 Attempt，必须用 attempt.signal 发请求，这样单次超时和 stop() 都能打断它；
- 失败时先用 classify 贴好 kind，再按上面的规则决定要不要重试；
- 决定重试时先调 onRetry（宿主显示"第几次重试、最多几次、等多久"），再等退避；
- 最终失败时抛出最后一个错误（带 kind），不包装，宿主看到的就是原始错误。
*/
export async function retry<T>(
    fn: (attempt: Attempt) => Promise<T>,
    settings: RetryOptions & { signal?: AbortSignal; onRetry?: (info: { attempt: number; maxTries: number; error: Error; delay: number }) => unknown } = {},
): Promise<T> {
    const { maxTries = Infinity, maxElapsed = Infinity, baseDelay = DEFAULT_BASE_DELAY, maxDelay = DEFAULT_MAX_DELAY, timeout, filter, signal, onRetry } = settings
    const started = Date.now()                                           // 总时长从第一次尝试开始算。
    for (let attempt = 1; ; attempt += 1) {
        if (signal?.aborted) throw cancelled()                          // 进来时（或退避结束时）已经取消：不再发请求。
        // 这一次专属的限时信号：每次重新计时，不能复用上一次的（它的定时器可能已经快到点）。
        const limit = timeout !== undefined && Number.isFinite(timeout) && timeout > 0 ? AbortSignal.timeout(timeout) : null
        const merged = limit && signal ? AbortSignal.any([signal, limit]) : limit ?? signal ?? new AbortController().signal
        try {
            return await fn({ attempt, signal: merged })
        } catch (error) {
            // 用户取消优先于一切：哪怕错误长得像网络错误，也按取消抛出，宿主只需要认 kind 'aborted'。
            if (signal?.aborted) throw cancelled()
            const kind = classify(error, limit)                           // 贴上 kind：限时到点会被判成 'timeout'。
            if (kind === 'aborted' || kind === 'overflow') throw error    // 取消不重试；超长交给 loop 压缩后重发。
            // 宿主过滤：函数返回 false 不重试；对象的 shouldRetry 返回 false、或命中任一 skip 维度不重试。
            const target = error as Record<string, any>
            if (typeof filter === 'function' && filter(error) === false) throw error
            if (filter && typeof filter === 'object') {
                if (typeof filter.shouldRetry === 'function' && filter.shouldRetry(error) === false) throw error
                if (filter.skipCodes?.includes(target?.statusCode)) throw error
                if (filter.skipKinds?.includes(kind)) throw error
                if (filter.skipText !== undefined) {
                    const text = `${target?.message ?? ''} ${target?.responseBody ?? ''}`
                    if (filter.skipText instanceof RegExp ? filter.skipText.test(text) : text.includes(String(filter.skipText))) throw error
                }
            }
            if (attempt > maxTries) throw error                           // maxTries 是"再重试几次"：第 maxTries + 1 次失败后停。
            const delay = Math.min(Math.round(baseDelay * 2 ** (attempt - 1)), maxDelay) // 5、10、20 … 直到封顶。
            if (Date.now() - started + delay > maxElapsed) throw error    // 再等一次就超过总时长：现在就停。
            void tell(onRetry, { attempt, maxTries, error: error as Error, delay }) // 宿主回调出错（含异步拒绝）不影响重试。
            // 等退避；期间 stop() 立刻结束等待。
            await new Promise<void>(resolve => {
                const timer = setTimeout(done, delay)
                function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
                signal?.addEventListener('abort', done, { once: true })
            })
        }
    }
}
