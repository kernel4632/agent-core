/*
history 的读写规则：只增不减，宿主手里的那个数组就是它，核心只原地往后追加。

调用示例：
    append(state.history, { role: 'user', content: '帮我写个爬虫' })   // 补 id、校验后 push，返回带 id 的那条
    turns(state.history)                                               // 按用户回合切分，context/build 用
    unanswered(state.history)                                          // 还没有结果的工具调用，stop 时补"已取消"

history 的形状（issue #30 Q1）：AI SDK 标准消息 + id，外加两种自定义 role：
- 'compact'：压缩总结，build 把最新一条折进 system；
- 'error'：宿主的失败记录，只存不发。

谁能调用 append：只有 loop（项目里唯一写 history 的地方）和 agent.send（把用户输入放进去后立刻交给 loop）。
本文件没有模块级可变状态：id 用 nanoid 现生成。
*/

import { nanoid } from 'nanoid'
import type { Draft, Message } from './types.ts'

/*
append：把一条草稿追加到 history 末尾，原地 push，返回追加进去的那条（带 id）。

- 草稿没给 id 就补一个；给了就保留（宿主 UI 用它定位、更新消息）；
- 入口校验：role 必须合法，content 不能是空串 / 空数组，媒体块必须有 mediaType 且载荷是字符串 / URL / 二进制。
  history 只增不删，一条坏消息写进去之后每次请求都会被 AI SDK 拒收，等于永久毒化会话，所以宁可在这里抛错；
- 不复制数组、不换引用：宿主持有的 agent.history 和这里改的是同一个对象。
*/
export function append(history: Message[], draft: Draft): Message {
    throw new Error('TODO')
}

/*
turns：按"用户回合"切分 history，返回二维数组，每一段以一条 user 消息开头。

- 开头如果不是 user（比如恢复的旧会话以 assistant 开头），这几条自成第 0 段；
- compact / error 消息留在它出现位置所属的那一段里，由 build 决定怎么用；
- 只读，不改原数组。context/build 按回合挑选开场 head 轮、总结前 beforeSummary 轮时用它。
*/
export function turns(history: Message[]): Message[][] {
    throw new Error('TODO')
}

/*
unanswered：找出 history 里"已经发出调用、但还没有对应结果"的工具调用。

loop 在 stop()、出错等每个出口都会用它，给这些调用补一条 cancelled 结果，
保证 assistant 的 tool-call 和 tool 的 tool-result 永远成对，下一次请求不会被模型拒收。
返回顺序与调用在 history 里出现的顺序一致。
*/
export function unanswered(history: Message[]): { toolCallId: string; toolName: string; input: unknown }[] {
    throw new Error('TODO')
}
