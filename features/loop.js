/*
目标被调用形式（绝对不可修改）：
const result = await Loop.run({
    // --- 数据（必填）---
    history: [],                // 完整历史消息列表
    system: "你是编程助手",         // 系统提示词
    tools: tools.schema,        // 给模型看的工具描述，来自 Tool.scan() 的 schema

    // --- LLM 参数（必填，内部传给 LLM.chat）---
    llm: {
        // 连接
        baseURL: "https://中转站/v1",
        apiKey: "sk-xxx",
        model: "model-name",
        protocol: "chat",          // chat / responses / anthropic
        // 参数覆盖
        options: {
            headers: {},
            body: {},
        },
    },
    retry: {
        maxDelay: 60000,
    },
    // --- 功能模块（必填，平齐的功能模块作为参数传）---
    buildContext: Context.build,       // 上下文构建模块
    compact: Compact.run,             // 上下文压缩模块
    executeTool: request => Tool.execute({ ...request, handlers: tools.handlers }), // 工具执行模块，handlers 由调用方补上
    sessionId: "session-1",               // 压缩和工具输出使用的会话

    // --- 控制（可选）---
    signal: abortSignal,           // 取消信号

    // --- 回调（全部可选）---
    onStart: () => { },                    // 循环开始
    onLLMStart: (request) => { },          // 每次实际请求模型前
    onLLMFinish: (result) => { },          // 本次模型请求完成，返回完整 result
    onLLMEvent: event => {},               // 原样接收 AI SDK 的所有流事件
    onRetry: (info) => { },                // 请求失败重试中
    onPermission: async (permission) => { }, // 工具权限询问，返回 true 或 false
    onToolResult: (result) => { },         // 工具执行完
    onCompact: (event) => { },             // 压缩过程通知
 })
 */

import History from '../utils/history.js'
import Retry from '../utils/retry.js'
import LLM from '../utils/llm.js'

const run = async ({
    history, system, tools, llm, retry = {}, buildContext, compact, executeTool, sessionId, signal,                     // 数据、LLM 参数、功能模块和取消信号
    onStart, onLLMStart, onLLMFinish, onPermission, onLLMEvent, onRetry, onToolCall, onToolOutput, onToolResult, onCompact, // 全部回调，没传的自动跳过
}) => {
    await onStart?.()          // 外部需要时知道循环已经开始；没有回调就跳过。等它完成，回调抛错才能顺着 send() 冒出去，而不是变成没人接的拒绝。
    let noToolCount = 0        // 记录连续没有工具调用的模型回合。
    let temporaryPrompt = null  // 工具提示只临时发送给模型，不写入 history。

    while (true) {
        // --- 每轮开始：先响应取消信号 ---
        if (signal?.aborted) throw new DOMException('Agent loop aborted', 'AbortError')

        // --- 构建上下文，Token 超限时压一次 ---
        // 每轮最多压一次，不循环压到达标为止：压缩本身就是一次真实模型请求，
        // 而"压完还是超限"通常意味着剩下的内容（单个巨大回合、或工具定义本身）根本压不动，
        // 循环只会一轮一轮地烧钱——实测 maxTokens 配小时能烧到 5500 次请求，
        // 每轮降一点点的情况下加了"没变小就停"的护栏也还能烧 122 次。
        // 压一次之后仍然超限就照常发出去，由模型服务判断收不收；下一轮如果还超，自然会再压一次。
        let context = buildContext({ history, system, tools })
        if (Number.isFinite(llm.maxTokens) && context.token >= llm.maxTokens * (llm.compactThreshold ?? 0.8)) {
            const content = await compact({ messages: context.messages, llm, stream: llm.stream, onCompact, signal }) // 自动压缩只在接近上限时触发；Compact 本身不判断上下文大小。
            history.push(History.compact({ content }))                       // 总结写回 history。
            context = buildContext({ history, system, tools })                // 用压缩后的历史重建上下文。
        }

        // --- 请求模型（含自动重试）---
        if (signal?.aborted) throw new DOMException('Agent loop aborted', 'AbortError')
        const result = await Retry.run({
            operation: async () => {
                const request = { messages: temporaryPrompt ? [...context.messages, History.user({ content: temporaryPrompt })] : context.messages, tools } // 临时提示只挂在本次请求上。
                await onLLMStart?.(request)                              // 每次重试都是一次真实模型请求。
                return LLM.chat({ ...llm, ...request, signal, onLLMEvent }) // 配置和本次请求内容一起交给 LLM。
            },
            signal, onRetry, maxDelay: retry.maxDelay, // 取消信号、重试通知和退避上限（秒）。
        })
        await onLLMFinish?.(result) // 上层拿到完整 result，自行选择 usage 或其他字段。
        temporaryPrompt = null      // 提示已经用过，下一轮默认不再携带。

        // --- 处理无工具调用的情况 ---
        const toolCalls = result.toolCalls || []                                                        // 模型这轮想调用的工具。
        const assistantMessages = result.responseMessages.filter(message => message.role === 'assistant') // 只保留 assistant 消息，保留思考和厂商内容。

        if (!toolCalls.length) {
            history.push(...assistantMessages)                                  // 保存模型完整 assistant 消息。
            noToolCount += 1                                                    // 累计没有工具调用的轮次。
            if (noToolCount === 2) temporaryPrompt = llm.noToolPrompt          // 第 2 轮：插入临时提示推一下模型。
            if (noToolCount >= 3) return { reason: 'no-tool' }  // 第 3 轮：放弃，直接返回结束原因。
            continue
        }
        noToolCount = 0 // 有工具调用，计数清零。

        // --- 并行执行所有工具调用 ---
        // Promise.all 让所有工具同时开跑，返回结果的顺序和 toolCalls 一致。
        // 流式输出通过 onToolOutput 带上 toolCallId 实时发出，上层靠 ID 区分是哪个工具的输出。
        const toolResults = await Promise.all(toolCalls.map(async call => {
            await onToolCall?.(call) // 让上层知道即将执行哪个工具。

            // AI SDK 标记 invalid 的调用：参数没法解析，或模型点了一个不存在的工具。
            // 此时 call.input 是原始字符串而不是对象，真跑下去等于拿脏数据喂工具。告诉模型让它重来。
            if (call.invalid) return { call, output: { type: 'error-text', value: `工具调用无效：${call.error?.message ?? '参数无法解析，或这个工具不存在'}` } }

            // 模型已经产生了完整工具调用。即使此刻被取消，也要给它补一条取消结果。
            if (signal?.aborted) return { call, output: { type: 'error-text', value: '工具执行已取消' }, stop: true }

            const allowed = await onPermission?.({ sessionId, toolCallId: call.toolCallId, toolName: call.toolName, arguments: call.input, signal }) ?? true // 没有权限回调时按无人值守模式直接放行。
            if (!allowed) return { call, output: { type: 'execution-denied', reason: '工具执行被用户拒绝' } } // 拒绝也是一条结果，模型需要知道。

            try {
                // onToolOutput 是高频流式回调，这里不等它：等一下就等于给模型输出加了一道节流阀。
                const value = await executeTool({ name: call.toolName, input: call.input, signal, onOutput: output => onToolOutput?.({ ...output, ...call }) }) // Loop 只说要执行哪个工具，怎么找到它由调用方负责。
                await onToolResult?.({ ...call, result: value, output: value.output })                              // 通知上层这个工具已经执行完。
                return { call, output: value.output, stop: value?.stop === true || value?.interrupted === true }    // 工具主动停止或被中断都要结束循环。
            } catch (error) {
                // 工具失败属于工具结果，不能让一次工具失败打断整个 Agent 循环。
                // 取消路径由 tool.js 用 resolve 处理，不会走到这里；这里接的是"工具名不在表里"这类调用错误。
                const output = { type: 'error-text', value: `工具执行失败：${error.message}` } // 失败信息也交给模型，让它自己决定怎么补救。
                await onToolResult?.({ ...call, error: error.message, output })
                return { call, output }
            }
        }))

        // --- 把本轮消息和工具结果写回历史 ---
        history.push(...assistantMessages) // AI SDK 的 tool 消息不用，工具结果由项目自己的执行器生成。
        for (const { call, output } of toolResults) history.push(History.tool({ toolCallId: call.toolCallId, toolName: call.toolName, content: output }))

        // --- 判断是否停止循环 ---
        if (toolResults.some(result => result.stop)) {                                          // 任何一个工具要求停止，整个循环就结束。
            if (signal?.aborted) throw new DOMException('Agent loop aborted', 'AbortError')      // 取消导致的停止，仍然按异常向上抛。
            return { reason: 'tool-stop' }                                                       // 工具主动要求停止时，返回结束原因。
        }
    }
}

export default { run }
