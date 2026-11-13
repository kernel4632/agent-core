/*
错误分类：给每个抛出去的模型 / 网络错误贴一个稳定的 kind，宿主和重试都按它分支。

调用示例：
    const kind = classify(error, timeoutSignal)   // 'auth' | 'limit' | 'overflow' | ...
    throw cancelled()                             // 用户 stop()：AbortError + kind 'aborted'

为什么"上下文超长"也在这里：它是一种分类（kind = 'overflow'），重试见到它不重试，
loop 见到它就强制压缩一次再重发——两边用同一份判据，判据只写一处。
本文件不导入任何东西，处在依赖图最底层；不持有任何模块级可变状态（正则是常量）。
*/

import type { ErrorKind } from '../types.ts'

// 通用的"上下文超长"措辞（照抄 Roo Code 的判据，大小写不敏感）：400 + 长度 / 窗口字样。
const OVERFLOW_GENERAL = /context length|window|maximum context|(input )?tokens? exceed|too many tokens/i
// Anthropic 家族特有的措辞，和状态码无关。
const OVERFLOW_ANTHROPIC = /prompt is too long|maximum.*tokens|context.*too.*long|exceeds.*context|token.*limit|context_length_exceeded/i

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
export function classify(error: unknown, timeout?: AbortSignal): ErrorKind {
    throw new Error('TODO')
}

/*
cancelled：造一个"已取消"错误。整个项目只在这里造，名字（AbortError）、kind（'aborted'）和措辞不会漂移。
stop() 打断运行时，send / compact 的 Promise 以它拒绝。
*/
export function cancelled(): Error {
    throw new Error('TODO')
}
