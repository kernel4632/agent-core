/* 这个文件管最小可运行的 agent 示例：起一个假的 OpenAI 兼容模型，用一个工具文件跑通一次完整循环，
   全程离线、不需要任何 API 密钥。

   运行（Bun 直接跑仓库源码，不需要 build）：

       bun examples/minimal/main.ts

   循环过程：问模型 → 模型要求调用 say_hello → 子进程执行工具 → 把结果再喂给模型 → 模型给出文字。
*/

import { fileURLToPath } from 'node:url'
import { Agent } from '../../index.ts' // 直接 import 仓库源码入口，Bun 会就地编译运行。

// --- 假模型：一个最小的 OpenAI 兼容接口，按"有没有收到工具结果"回两种回答 ---
const server = Bun.serve({
    port: 0, // 让系统分配空闲端口。
    async fetch(request) {
        const body = await request.json() as { messages: { role: string }[] }
        const answered = body.messages.some(message => message.role === 'tool')
        const message = answered
            ? { role: 'assistant', content: '招呼已经打完了，任务结束。' }
            : { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'say_hello', arguments: '{"who":"世界"}' } }] }
        return Response.json({ choices: [{ index: 0, message, finish_reason: answered ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    },
})

// --- 创建 Agent：配置平铺；tools 是路径数组，目录是"其中全部工具文件"的简写 ---
const agent = Agent.create({
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: 'k',        // 假模型不校验。
    model: 'mock',
    stream: false,      // 非流式，响应形状最简单。
    system: '你是一个助手，需要打招呼时请调用 say_hello 工具。',
    noToolRounds: 1,    // 演示用：模型一停手就结束。
    tools: [fileURLToPath(new URL('./tools', import.meta.url))],
})

// --- 发指令，等循环结束；回调按次传入 ---
const answer = await agent.send('请向世界打个招呼', {
    onToolResult: result => console.log('工具执行完了：', result.toolName, '→', JSON.stringify(result.output)),
})
console.log(answer.text, answer.reason)

server.stop(true) // 关掉假模型，进程才能正常退出。
