/*
relay：录制 / 回放真实模型请求的本地中转（"中转程序"）。离线测试指向它的回放模式，就不再需要手写模拟。

用法：
    LINGLOFT_BASE_URL=... bun scripts/relay.ts record 8787     // 命令行：转发到上游并录制，Ctrl+C 结束
    bun scripts/relay.ts replay 8787                          // 命令行：只回放录好的数据，不连网
    const relay = start({ mode: 'replay' })                   // 代码里：端口自动分配
    const baseURL = relay.url('anthropic', 'claude-opus-latest', 'text-stream', '/v1')

路径约定：http://127.0.0.1:端口/<协议>/<模型>/<场景>/<上游路径>。前三段只用来给录制文件定位，
转发时剥掉，剩下的路径（例如 /v1/chat/completions、/v1beta/models/x:streamGenerateContent?alt=sse）原样接到上游源站后面。
这样 agent-core 只要换 baseURL 就能录 / 放，不需要任何钩子，被测代码和线上完全一样。

录制文件：<dir>/<协议>/<模型>/<场景>.json，内容是这个场景按顺序发生的全部往返（exchanges）：
    request：方法、上游路径、请求头（密钥类全部脱敏）、请求体（JSON 能解析就存对象）；
    response：状态码、响应头、按到达顺序的原始分块 chunks（流式 SSE 的每一块原样保留，非流式通常只有一两块）。
同一场景里第 N 次请求回放第 N 条往返；用完了返回 599，测试会以错误形式看见"录制数据不够"。
回放时请求体和录制时不同会记进 relay.drift（不阻断），测试据此发现"发出去的请求变了，该重录了"。

安全：任何名字里带 key / token / auth / cookie 的请求头都换成 <redacted>，写文件前再把真实 key 全文替换一次，双保险。
本文件不导入 src/ 下任何东西，只依赖 Bun。
*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type Mode = 'record' | 'replay'
export interface Exchange {
    request: { method: string; path: string; headers: Record<string, string>; body: unknown }
    response: { status: number; headers: Record<string, string>; chunks: string[] }
}
export interface Relay { port: number; url: (protocol: string, model: string, scenario: string, base?: string) => string; drift: string[]; stop: () => void }

// 默认录制目录：仓库里的 tests/fixtures/real。
const DIR = join(import.meta.dir, '..', 'tests', 'fixtures', 'real')
// 这些响应头由 Bun 的 fetch 处理过（已解压、已重新分块），原样回放会让客户端解析出错，不录。
const DROP = /^(content-encoding|content-length|transfer-encoding|connection|set-cookie|keep-alive)$/i
const SECRET = /key|token|auth|cookie/i

/*
start：起一个本地 HTTP 服务。record 模式需要 upstream（例如 https://api.lingloft.cn），没给就读 LINGLOFT_BASE_URL 的源站。
secret 是要从录制文件里抹掉的真实 key（默认读 LINGLOFT_API_KEY）。返回端口、拼地址的 url()、回放偏差 drift 和 stop()。
*/
export function start(options: { mode: Mode; dir?: string; port?: number; upstream?: string; secret?: string }): Relay {
    const { mode, dir = DIR } = options
    const upstream = options.upstream ?? (process.env.LINGLOFT_BASE_URL ? new URL(process.env.LINGLOFT_BASE_URL).origin : '')
    const secret = options.secret ?? process.env.LINGLOFT_API_KEY ?? ''
    if (mode === 'record' && !upstream) throw new Error('record 模式需要 upstream 或 LINGLOFT_BASE_URL')
    const recorded = new Map<string, Exchange[]>()                       // 录制中：场景 → 已完成的往返（每次完成就整份写盘）
    const cursor = new Map<string, number>()                             // 回放中：场景 → 下一条要放的序号
    const drift: string[] = []

    // 场景文件的路径与读写：写之前抹掉 key，文件格式缩进 1 方便 diff 又不至于太大。
    const fileOf = (key: string) => join(dir, `${key}.json`)
    const save = (key: string, list: Exchange[]) => {
        const file = fileOf(key)
        mkdirSync(dirname(file), { recursive: true })
        let text = JSON.stringify({ scenario: key, exchanges: list }, null, 1)
        if (secret) text = text.replaceAll(secret, '<redacted>')
        writeFileSync(file, text + '\n')
    }
    const load = (key: string): Exchange[] => existsSync(fileOf(key)) ? JSON.parse(readFileSync(fileOf(key), 'utf8')).exchanges : []

    const server = Bun.serve({
        port: options.port ?? 0,
        idleTimeout: 0,                                                   // 有的模型首字要等两分钟，不能被空闲超时掐断。
        async fetch(incoming) {
            const url = new URL(incoming.url)
            const [protocol, model, scenario, ...rest] = url.pathname.split('/').filter(Boolean)
            if (!scenario) return new Response('path must be /<protocol>/<model>/<scenario>/...', { status: 400 })
            const key = `${protocol}/${model}/${scenario}`
            const path = `/${rest.join('/')}${url.search.replace(/([?&]key=)[^&]*/i, '$1<redacted>')}`
            const raw = await incoming.text()
            let body: unknown = raw
            try { body = raw ? JSON.parse(raw) : null } catch { /* 不是 JSON：按原文存 */ }
            const headers: Record<string, string> = {}
            incoming.headers.forEach((value, name) => { headers[name] = SECRET.test(name) ? '<redacted>' : value })
            const request = { method: incoming.method, path, headers, body }

            // --- 回放：按序号取录好的往返，原样按块吐回去 ---
            if (mode === 'replay') {
                const index = cursor.get(key) ?? 0
                cursor.set(key, index + 1)
                const one = load(key)[index]
                if (!one) return new Response(JSON.stringify({ error: { message: `回放数据用完：${key} 第 ${index + 1} 次请求没有录制` } }), { status: 599, headers: { 'content-type': 'application/json' } })
                if (JSON.stringify(one.request.body) !== JSON.stringify(body)) drift.push(`${key}#${index + 1}`)
                const encoder = new TextEncoder()
                const stream = new ReadableStream({ start(controller) { for (const chunk of one.response.chunks) controller.enqueue(encoder.encode(chunk)); controller.close() } })
                return new Response(stream, { status: one.response.status, headers: { 'content-type': one.response.headers['content-type'] ?? 'application/json' } })
            }

            // --- 录制：转发到上游，边收边吐给客户端、边记分块；客户端取消就取消上游，已收到的照样存 ---
            const forward = new Headers(incoming.headers)
            forward.delete('host')
            const answer = await fetch(upstream + `/${rest.join('/')}${url.search}`, { method: incoming.method, headers: forward, body: raw || undefined, signal: incoming.signal, keepalive: false }) // 不复用连接：被取消的流会让下一条复用它的请求直接断掉。
            const responseHeaders: Record<string, string> = {}
            answer.headers.forEach((value, name) => { if (!DROP.test(name)) responseHeaders[name] = value })
            const exchange: Exchange = { request, response: { status: answer.status, headers: responseHeaders, chunks: [] } }
            const list = recorded.get(key) ?? []
            recorded.set(key, list)
            list.push(exchange)                                           // 先占位：同一场景的并发请求也保持发出顺序。
            const finish = () => save(key, list)
            const decoder = new TextDecoder()
            const reader = answer.body?.getReader()
            const stream = new ReadableStream({
                async pull(controller) {
                    try {
                        const { done, value } = reader ? await reader.read() : { done: true, value: undefined }
                        if (done) { const tail = decoder.decode(); if (tail) exchange.response.chunks.push(tail); finish(); controller.close(); return }
                        const text = decoder.decode(value, { stream: true })
                        if (text) exchange.response.chunks.push(text)
                        controller.enqueue(value)
                    } catch (error) { finish(); controller.error(error) }
                },
                cancel() { finish(); reader?.cancel().catch(() => {}) },  // 上游被取消时 cancel 自己会以 AbortError 拒绝：接住，别变成未处理拒绝。
            })
            return new Response(stream, { status: answer.status, headers: { 'content-type': answer.headers.get('content-type') ?? 'application/json' } })
        },
    })
    const port = server.port!
    return {
        port,
        url: (protocol, model, scenario, base = '/v1') => `http://127.0.0.1:${port}/${protocol}/${model}/${scenario}${base}`,
        drift,
        stop: () => void server.stop(true),
    }
}

// 命令行入口：bun scripts/relay.ts <record|replay> [端口]
if (import.meta.main) {
    const mode = (process.argv[2] ?? 'replay') as Mode
    if (mode !== 'record' && mode !== 'replay') throw new Error('用法：bun scripts/relay.ts <record|replay> [端口]')
    const relay = start({ mode, port: Number(process.argv[3] ?? 8787) })
    console.log(`relay ${mode} 已启动：${relay.url('<协议>', '<模型>', '<场景>')}`)
}
