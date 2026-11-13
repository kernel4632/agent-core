/*
loop：唯一的编排者，也是整个项目里唯一写 history 的地方。自己不持有任何状态，状态都从参数 state 拿。

调用示例（只在 agent.ts 里）：
    const answer = await run(state, callbacks)              // send：跑到结束，返回 { reason, text, usage, output }
    const summary = await compact(state, callbacks, 'manual') // agent.compact()：强制压缩一次

run 的一轮（循环直到 decide 说结束，不设最大轮数）：
1. 现读工具：tools/load（agent.tools 的元数据）+ tools/mcp connect（agent.mcp），合成这一轮的工具描述表；
2. context/build 现拼上下文；over 为 true 就调 compact('auto') 后重新 build——"何时压"只在这里判断一处；
3. onInject 问宿主要不要临时附一句话；连同上一轮 decide 给的提醒，只挂在这一次请求上，不写进 history；
4. model/ask 问模型（流式片段转给 onChunk）；拿到真实 usage 后用 utils/tokens.calibrate 校准 state.ratios；
   模型报 kind 'overflow'（上下文超长）时强制 compact 一次再重发，最多 3 次；
5. 把回复（assistant 消息）追加进 history；
6. 对每个工具调用发 onToolCall，逐个问 onPermission（没有回调 = 无人值守，直接放行；严格 true 才放行），
   被拒绝的直接写拒绝结果；放行的交给 tools/run 全部并行执行；
7. 结果按调用顺序追加进 history（tool 消息），并发 onToolResult / onChunk('tool-result') / onStep；
8. loop/decide 判断：继续、带提醒继续、或结束。

每个出口（正常结束、stop()、出错）都会用 history.unanswered 给悬空的调用补一条"已取消"结果，保证 history 不坏。
stop() 时 state.internal.controller 被 abort：ask 抛 kind 'aborted'，run 补完结果后以 cancelled() 拒绝。

导入：同目录 decide；context/build、context/summarize；model/ask；tools/load、tools/run、tools/mcp；
history；utils/tokens、utils/errors。全部是向下或同目录，从不导入 agent。
*/

import type { Answer, Callbacks, State } from '../types.ts'
import { decide } from './decide.ts'
import { build } from '../context/build.ts'
import * as summarize from '../context/summarize.ts'
import { ask } from '../model/ask.ts'
import { load } from '../tools/load.ts'
import { connect } from '../tools/mcp.ts'
import { run as runTools } from '../tools/run.ts'
import { append, unanswered } from '../history.ts'
import { calibrate } from '../utils/tokens.ts'
import { cancelled, classify } from '../utils/errors.ts'

// 上下文超长时最多"压缩后重发"几次（照抄 Roo Code 的 MAX_CONTEXT_WINDOW_RETRIES）。
export const OVERFLOW_RETRIES = 3

/*
run：按文件头的八步跑完一次 send，返回最终结果。

- 每一轮都从 state 现读 config / history / tools / mcp，宿主运行中改它们，下一轮立即生效；
- 返回的 text 是最后一次模型回复的正文，usage 是这次 run 里全部请求（含压缩请求）的合计，
  output 是结构化输出（config.output 有值时）；和回调里实时给出的内容一致；
- 连续不调工具的计数 idle、提醒文字、用量合计都是这次调用的局部变量，不进 state。
*/
export async function run(state: State, callbacks: Callbacks = {}): Promise<Answer> {
    throw new Error('TODO')
}

/*
compact：整个项目唯一的压缩逻辑（取代旧实现的三个同名 compact）。只负责压缩，不判断要不要压。

1. build 当前上下文；
2. summarize.request 拼"写总结"的请求（可用 config.compact 里的便宜模型）；
3. ask 问模型，取回总结文字；
4. summarize.wrap 包成 role:'compact' 消息，append 进 history；
5. 发 onCompact（reason、压缩前后估算 token、用量），返回总结文字。
reason 为 'manual' 时来自宿主的 agent.compact()，'auto' 时来自 run 的阈值判断或超长重发。
*/
export async function compact(state: State, callbacks: Callbacks = {}, reason: 'auto' | 'manual' = 'manual'): Promise<string> {
    throw new Error('TODO')
}
