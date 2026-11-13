/*
decide：一轮模型回复、工具执行完之后，判断继续、挂提醒后继续，还是结束。

调用示例：
    const decision = decide({ reply, results, idle, hasTools }, state.config)
    // { action: 'continue' } | { action: 'remind', reminder } | { action: 'end', reason }

规则（issue #30 第 5 步，作者的设计）：
- 任一工具结果带 stop:true → 结束，reason 'tool-stop'；
- 本轮调了工具 → 继续；
- 本轮没调工具：
  - 有结构化输出结果，或根本没有可用工具 → 结束，reason 'finished'（这就是最终回答）；
  - 连续不调工具达到 noToolRounds 轮 → 结束，reason 'no-tool'；
  - 恰好到上限前一轮 → 'remind'，提醒文字取自 config.noToolPrompt（这条提醒只挂在下一次请求上，不写进 history）；
  - 其余 → 继续。
- 不设最大轮数。

decide 只做判断、不做任何副作用；连续不调工具的计数 idle 由 loop/run 在一次 run 的局部变量里维护，
这里不持有任何状态，也不导入任何本项目文件（只 import type）。
*/

import type { Config, Decision, Reply, ToolResult } from '../types.ts'

// 默认连续 3 轮不调工具就结束：太少会误伤纯聊天，太多则白烧轮次。
export const DEFAULT_NO_TOOL_ROUNDS = 3
// 默认提醒原文：写成"系统提醒、请勿对话回复"，防止模型把它当成用户的话接着闲聊。
export const DEFAULT_NO_TOOL_PROMPT = '[错误] 你刚才的响应中没有使用工具！请继续使用工具（这是一条系统提醒消息，请勿以对话形式回复）'

// decide 需要的这一轮事实：模型回复、工具结果、包括本轮在内连续几轮没调工具、这一轮有没有可用工具。
export interface Round { reply: Reply; results: ToolResult[]; idle: number; hasTools: boolean }

/*
decide：按文件头的规则返回判断结果。默认值在读的时候补（config.noToolRounds ?? 3），
宿主整份替换 config 也不会丢默认值；noToolRounds 为 Infinity 时永不因不调工具而结束。
*/
export function decide(round: Round, config: Config): Decision {
    throw new Error('TODO')
}
