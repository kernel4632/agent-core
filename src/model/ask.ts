/*
ask：对 AI SDK 的薄封装，"统一请求数据 → 统一结果"，协议只是参数。公开为 Agent.LLM.ask。

调用示例（不需要 Agent 实例）：
    const { text, toolCalls, usage, output } = await Agent.LLM.ask(
        { model: 'gpt-4o', baseURL, apiKey, protocol: 'chat', messages, tools, textTools: false, retry: { maxTries: 3 } },
        chunk => { if (chunk.type === 'text') process.stdout.write(chunk.text) },
    )

一次 ask 做的事：
1. configure(request) 翻译成 AI SDK 参数；
2. textTools 为 true：describe 把工具说明写进 system、render 把历史工具消息改写成文字，不发原生 tools；
   否则把 tools 描述表转成 AI SDK 的工具定义（只有 schema，没有 execute——执行在 loop 里做）；
3. 用 retry 包住真正的请求：stream 时走 streamText，把 AI SDK 事件简化成 Chunk 交给 onChunk；
   否则走 generateText。两条路径产出完全相同的 Reply；
4. textTools 为 true 时用 parse 从文字里解析出调用；
5. 用量补齐五个字段（缺的补 0）；错误一律经 classify 贴上 kind 再抛。

ask 不读写 history、不估算 token、不执行工具；它对 loop 一无所知，所以宿主也能直接拿来用。
导入：同目录 configure、text-tools/describe、text-tools/parse，以及 utils/retry、utils/errors。
*/

import type { AskRequest, Chunk, Reply } from '../types.ts'
import { configure } from './configure.ts'
import { describe, render } from './text-tools/describe.ts'
import { parse } from './text-tools/parse.ts'
import { retry } from '../utils/retry.ts'
import { classify } from '../utils/errors.ts'

/*
ask：按文件头的五步问一次模型，返回 Reply。

- onChunk 只在 stream 为 true 时被调用；片段至少有 text / tool-call / finish（reasoning 有就给）；
- 返回值里的 messages 是要追加进 history 的 AI SDK 消息（assistant，带 tool-call 块；不带 id），
  textTools 模式下也是标准的 tool-call 块，这样 history 永远只有一种格式；
- request.signal 取消时抛 kind 'aborted' 的错误；单次超时、重试次数、总时长都来自 request.retry。
*/
export async function ask(request: AskRequest, onChunk?: (chunk: Chunk) => void): Promise<Reply> {
    throw new Error('TODO')
}
