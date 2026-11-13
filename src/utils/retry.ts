/*
重试：模型 / 网络错误由内核重试，次数、总时长、单次超时都由宿主通过 config 配置。

调用示例：
    const reply = await retry(attempt => send(attempt), { maxTries: 3, maxElapsed: 60000, timeout: 30000, signal, onRetry })

规则（照抄 Roo Code 的退避策略）：
- 默认任何错误都重试，除了 kind 为 'aborted'（用户取消）和 'overflow'（上下文超长，交给 loop 压缩后重发）；
- 宿主的 filter 命中时不重试；
- 退避从 baseDelay 开始每次 ×2，单次不超过 maxDelay；maxTries 和 maxElapsed 谁先到谁停；
- 每次尝试都套一个 timeout 限时信号；超时的错误由 classify 贴成 'timeout'，照常参与重试；
- signal 一旦取消，正在等的退避立刻结束并抛 cancelled()。

本文件只依赖同目录的 errors.ts；没有模块级可变状态，计数都在一次 retry 调用的局部变量里。
*/

import type { RetryOptions } from '../types.ts'
import { classify, cancelled } from './errors.ts'

// 默认退避基数 5 秒、单次上限 10 分钟（Roo Code 的取值）；次数和总时长默认不限。
export const DEFAULT_BASE_DELAY = 5000
export const DEFAULT_MAX_DELAY = 600000

// 一次尝试拿到的上下文：第几次（从 1 开始），以及这一次专属的限时 + 取消合并信号。
export interface Attempt { attempt: number; signal: AbortSignal }

/*
retry：反复执行 fn 直到成功、命中不重试的错误、次数或总时长用尽，或被取消。

- fn 每次收到新的 Attempt，必须用 attempt.signal 发请求，这样单次超时和 stop() 都能打断它；
- 失败时先用 classify 贴好 kind，再按上面的规则决定要不要重试；
- 决定重试时先调 onRetry（宿主显示"第几次重试、等多久"），再等退避；
- 最终失败时抛出最后一个错误（带 kind），不包装，宿主看到的就是原始错误。
*/
export async function retry<T>(
    fn: (attempt: Attempt) => Promise<T>,
    options: RetryOptions & { signal?: AbortSignal; onRetry?: (info: { attempt: number; error: Error; delay: number }) => void } = {},
): Promise<T> {
    throw new Error('TODO')
}
