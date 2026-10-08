/*
这个脚本管什么：
    在本地起一个假的 OpenAI 兼容模型（只实现 /v1/chat/completions），用仓库源码
    （import Agent from '../index.js'）跑一次「长跑 + 多会话并发」压测。
    目的不是测某一条逻辑，而是看长时间、多台会话同时跑的情况下，Agent 会不会：
    崩、抛错、某次 send 挂起不结算、把别的会话的内容串进自己的 history、内存一直涨、
    或者工具子进程越积越多。

怎么跑：
    bun scripts/stress.js
    不联网、不需要任何 API key。脚本自己起假模型、自己起会话、跑完自己收尾并退出。
    只新增这一个文件；临时工具文件写在系统临时目录里，跑完删掉。

会打印什么：
    结尾一段中文汇总表，包含：
      完成 / 失败 / 挂起 的次数；
      模型主请求数、压缩请求数、工具调用数（证明真的走到了多轮工具和 compact 路径）；
      每台会话 history 的长度，以及是否只包含自己的编号（串台检查）；
      内存增量：分两批跑，比较两批的 heapUsed 增量，再看释放引用并 GC 后能否回落；
      工具子进程数量：跑前 / 两批之后各测一次（进程池最多留 8 个空闲进程，数量不随批次增长才算正常）。
*/

import Agent from '../index.js'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// --- 可调参数：全部集中在这里，方便按机器性能调 ---
const AGENT_COUNT = 8        // 并发会话数
const SENDS_PER_BATCH = 15   // 每台会话每批跑多少次 send
const BATCH_COUNT = 2        // 跑两批，比较两批的内存增量
const SEND_TIMEOUT = 20000   // 单次 send 超过多久算挂起（毫秒）
const MAX_CONTEXT_TOKENS = 1200 // 上下文预算；配合 compactThreshold 让长跑真的触发压缩
const COMPACT_THRESHOLD = 0.5 // 估算 token 达到预算的 50% 就压缩；压一次后能落到阈值以下，不会每轮都压

const log = console.log
const gc = () => { try { Bun.gc?.(true) } catch {} }
const heapMB = () => { gc(); return process.memoryUsage().heapUsed / (1024 * 1024) }
const sleep = ms => Bun.sleep(ms)

// --- 统计量 ---
const totals = { submitted: 0, done: 0, failed: 0, hang: 0 }
const reasons = new Map() // send 的结束原因 → 次数
const failures = []

// --- 假模型服务：非流式 OpenAI Chat 兼容 ---
// 行为：
//   带压缩指令的请求 → 返回一段短总结（走 compact 路径）
//   普通请求：一律回 echo 的 tool_calls，让 Loop 多轮调工具，直到撞上 maxSteps 才收尾。
//   为什么不用"模型给最终文字"来收尾：压缩会把最近的用户消息和工具回合裁掉，
//   模型下一轮未必还看得到这次 send 的编号。让 send 由 maxSteps 收尾，结果就只取决于循环本身，
//   不会被压缩的裁剪行为干扰，压测才测的是被测代码而不是假模型的假设。
// 编号从用户消息里读出来，模型回显的一定是这台会话自己的编号；谁串台了一眼能看出来。
const stats = { main: 0, compact: 0, toolCalls: 0 }
let callSeq = 0

const TOKEN_IN_TEXT = /\[([A-Za-z0-9]+-\d+-\d+)\]/
const hasSummarizeText = messages => messages.some(message => {
    const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content) ? message.content.map(part => part?.text ?? '').join('') : ''
    return text.includes('请把以上对话压缩成一段总结')
})

const findTask = messages => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]
        if (message.role !== 'user' || typeof message.content !== 'string') continue
        const match = message.content.match(TOKEN_IN_TEXT)
        if (match) return { index: i, token: match[1] }
    }
    return null
}

const reply = ({ content = null, toolCall = null, finish }) => Response.json({
    id: `chatcmpl-${++callSeq}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'stress-model',
    choices: [{
        index: 0,
        message: toolCall
            ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${callSeq}`, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] }
            : { role: 'assistant', content },
        finish_reason: toolCall ? 'tool_calls' : (finish ?? 'stop'),
    }],
    usage: {}, // 不给真实 usage：token 估算器保持默认比例，压缩触发时机可复现。
})

const server = Bun.serve({
    port: 0,
    async fetch(request) {
        const body = await request.json().catch(() => ({}))
        const messages = Array.isArray(body.messages) ? body.messages : []

        if (hasSummarizeText(messages)) {
            stats.compact += 1
            return reply({ content: '压缩总结：任务仍在进行，之前若干步已由工具确认。' })
        }

        stats.main += 1
        stats.toolCalls += 1
        const token = findTask(messages)?.token ?? 'unknown'
        return reply({ toolCall: { name: 'echo', args: { value: token } } })
    },
})

// --- 临时工具文件：走真实的工具子进程池（不是主进程内存工具） ---
const makeTempToolDir = async () => {
    const dir = join(tmpdir(), 'opencode', `agent-core-stress-${process.pid}-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'echo.js'), [
        'export default {',
        "    name: 'echo',",
        "    description: '原样返回输入编号',",
        '    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },',
        '    async execute(input) { return { output: { type: "text", value: `done:${input.value}` } } },',
        '}',
    ].join('\n'))
    return dir
}

// --- 观测工具子进程：数当前进程名带 bun 的直接子进程 ---
const countToolChildren = () => {
    try {
        const script = `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object { $_.Name -like 'bun*' }).Count`
        const out = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], { stdout: 'pipe', stderr: 'pipe' })
        const value = Number(out.stdout.toString().trim())
        return Number.isFinite(value) ? value : null
    } catch {
        return null
    }
}

// --- 跑一批：所有会话并行，每台会话内部按顺序 send（send 会顶掉上一次，必须顺序） ---
const ids = Array.from({ length: AGENT_COUNT }, (_, i) => `ag${i}`)
const expected = new Map(ids.map(id => [id, new Set()]))

const runBatch = async (agents, batch) => {
    await Promise.all(agents.map(async (agent, i) => {
        const id = ids[i]
        for (let k = 1; k <= SENDS_PER_BATCH; k += 1) {
            const token = `${id}-${batch}-${k}`
            expected.get(id).add(token)
            totals.submitted += 1

            const task = agent.send(`任务[${token}]：请调用 echo 工具原样回显这个编号。`)
            task.catch(() => {}) // 挂起分支先结算时，迟到结果别变成未处理拒绝。
            const outcome = await Promise.race([
                task.then(result => ({ state: 'done', result }), error => ({ state: 'failed', error })),
                sleep(SEND_TIMEOUT).then(() => ({ state: 'hang' })),
            ])

            if (outcome.state === 'done') {
                totals.done += 1
                const reason = outcome.result?.reason ?? 'unknown'
                reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
            } else if (outcome.state === 'failed') {
                totals.failed += 1
                failures.push({ id, token, message: outcome.error?.message ?? String(outcome.error) })
            } else {
                totals.hang += 1
                failures.push({ id, token, message: `超过 ${SEND_TIMEOUT}ms 仍未结算` })
            }
        }
    }))
}

// --- 串台检查：每台 history 里的编号必须全部是自己的，且自己该出现的编号一个都不能少 ---
const checkIsolation = agents => {
    const pattern = /\bag\d+-\d+-\d+\b/g
    let foreign = 0
    let missing = 0
    const lengths = []
    agents.forEach((agent, i) => {
        const id = ids[i]
        const found = new Set(JSON.stringify(agent.history).match(pattern) ?? [])
        for (const token of found) if (!token.startsWith(`${id}-`)) foreign += 1
        for (const token of expected.get(id)) if (!found.has(token)) missing += 1
        lengths.push(`${id}=${agent.history.length}`)
    })
    return { foreign, missing, lengths }
}

// --- 主流程 ---
const main = async () => {
    const started = Date.now()
    const tempDir = await makeTempToolDir()
    const fileTools = await Agent.tool.scan(tempDir)

    const config = {
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKey: 'stress',
        model: 'stress-model',
        stream: false,
        system: '你是压测用的助手。',
        maxContextTokens: MAX_CONTEXT_TOKENS,
        compactThreshold: COMPACT_THRESHOLD,
        noToolRounds: Infinity, // 模型一直调工具，不用"连续无工具"来收尾
        maxSteps: 4,            // 每次 send 固定跑 4 轮工具后按 step-limit 收尾
        retryMaxElapsed: 0,     // 本地假模型不该失败；真失败就如实抛出来，不要一直重试
    }

    const childrenBefore = countToolChildren()
    const heapStart = heapMB()
    const agents = ids.map(id => Agent.create({ id, config, tools: fileTools }))

    const heapMarks = []
    for (let batch = 1; batch <= BATCH_COUNT; batch += 1) {
        await runBatch(agents, batch)
        await sleep(200)
        heapMarks.push({ batch, heap: heapMB(), children: countToolChildren() })
    }

    const isolation = checkIsolation(agents)
    const heapEnd = heapMB()

    // 释放引用 + GC，看内存能不能回落（回落说明没有隐藏的强引用在漏）
    agents.length = 0
    await sleep(200)
    const heapAfterRelease = heapMB()

    const childrenAfter = countToolChildren()
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)

    const delta1 = heapMarks[0].heap - heapStart
    const delta2 = heapMarks[1].heap - heapMarks[0].heap
    const ratio = delta1 > 0.5 ? (delta2 / delta1) : null // 两批增量比，接近 1 表示线性（历史在长），远大于 1 才可疑

    const pass = totals.failed === 0 && totals.hang === 0 && isolation.foreign === 0 && isolation.missing === 0 && stats.compact > 0 && stats.toolCalls > 0
    const reasonText = [...reasons.entries()].map(([reason, count]) => `${reason}×${count}`).join('  ') || '无'

    log('================ 长跑 + 多会话并发压测汇总 ================')
    log(`会话数                 : ${AGENT_COUNT}`)
    log(`每台 send 次数          : ${SENDS_PER_BATCH * BATCH_COUNT}（${BATCH_COUNT} 批 × ${SENDS_PER_BATCH}）`)
    log(`提交 send 总数          : ${totals.submitted}`)
    log(`完成                    : ${totals.done}`)
    log(`失败 / 抛错             : ${totals.failed}`)
    log(`超时挂起                : ${totals.hang}`)
    log(`结束原因                : ${reasonText}`)
    log(`模型主请求 / 压缩 / 工具 : ${stats.main} / ${stats.compact} / ${stats.toolCalls}`)
    log(`串台（别的会话编号）    : ${isolation.foreign}`)
    log(`缺失（自己的编号不见）  : ${isolation.missing}`)
    log(`每台 history 长度        : ${isolation.lengths.join('  ')}`)
    log(`heapUsed 起始           : ${heapStart.toFixed(1)} MB`)
    log(`heapUsed 批次1后        : ${heapMarks[0].heap.toFixed(1)} MB  (Δ +${delta1.toFixed(1)})`)
    log(`heapUsed 批次2后        : ${heapMarks[1].heap.toFixed(1)} MB  (Δ +${delta2.toFixed(1)})`)
    log(`批次增量比 (批2/批1)    : ${ratio === null ? '无法判断' : `${ratio.toFixed(2)}x`}`)
    log(`释放引用 + GC 后 heap   : ${heapAfterRelease.toFixed(1)} MB`)
    log(`工具子进程 跑前/批1后/批2后: ${childrenBefore ?? '无法观测'} / ${heapMarks[0].children ?? '无法观测'} / ${childrenAfter ?? '无法观测'}`)
    log(`耗时                    : ${elapsed} 秒`)
    log(`结果                    : ${pass ? 'PASS' : 'FAIL'}`)
    if (failures.length) {
        log('失败样例（最多 5 条）:')
        for (const one of failures.slice(0, 5)) log(`  [${one.id}] ${one.token} → ${one.message}`)
    }
    log('==========================================================')

    server.stop(true)
    await rm(tempDir, { recursive: true, force: true })
    process.exitCode = pass ? 0 : 1
}

await main()
