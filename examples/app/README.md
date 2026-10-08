# app —— 离线可跑的小型 chat 服务

这是一个**面向应用层**的完整示例：它把"要拿 agent-core 去写真实应用"时必须自己接的每一环都接上，
比 [`../minimal/`](../minimal/) 详尽得多。默认用本地假模型，不需要任何 API 密钥，离线就能跑。

```bash
bun run examples/app/server.js
```

启动后会监听 `http://127.0.0.1:8787`，并同时起一个假模型（`mock-model.js`）。
换端口用 `PORT=9000`，换数据目录用 `DATA_DIR=...`。

## 这个示例演示了哪些环节

| 环节 | 在哪里看 | 说明 |
|------|----------|------|
| 会话管理 | `server.js` 的 `sessions` 集合 | `Map<id, 会话>`，每个会话一台 `Agent.create`，历史互相独立 |
| 持久化 | `store.js` + `onStep` | 每轮结束把 `history` 落盘到 `.data/<id>.json`，重启后自动读回来 |
| 流式 | `POST .../messages` 的 SSE | 用 `onLLMEvent` 抓 `text-delta`，把增量写进 `ReadableStream` |
| 权限 | `onPermission` | 读操作放行，写操作（`write_note`）单独询问并打印决定 |
| 观测 | 一组 `callbacks` | `onLLMStart/Finish` 记耗时和 usage，`onToolCall/Result` 记工具耗时，`onStep` 落盘，`onCompact` 记压缩 |
| 取消 | `POST .../stop` | 调 `agent.stop()`；取消的结果以 `aborted` 事件返回，不当失败 |
| 生产设置 | `server.js` 的 `config` | `maxToolOutput` / `maxToolConcurrency` / `requestTimeout` / `retryMaxElapsed` / `maxContextTokens` / `maxSteps` |
| 换真模型 | `server.js` 顶部 | 设 `BASE_URL` / `API_KEY` / `MODEL` 就用真模型，否则用假模型 |
| 两种工具来源 | `tools/` + `server.js` | 目录里的文件工具（子进程）和代码里的内存工具混用 |

文件分工：`server.js` 管接线和路由，`store.js` 管历史落盘，`mock-model.js` 管本地假模型，
`tools/now.js`、`tools/read-file.js` 是两个文件工具。

## 接口

| 方法 | 路径 | 作用 |
|------|------|------|
| `POST` | `/sessions` | 建会话，返回 `{ id }`；带 `{ "id": "..." }` 则恢复老会话 |
| `POST` | `/sessions/:id/messages` | 发消息，默认返回 SSE 流；加 `?stream=0` 或 `Accept: application/json` 返回一次性 JSON |
| `POST` | `/sessions/:id/stop` | 中断当前这次运行 |
| `POST` | `/sessions/:id/compact` | 手动压缩上下文 |
| `GET` | `/sessions/:id/history` | 返回历史和一段渲染好的文字 |
| `GET` | `/healthz` | 存活检查 |

## 用 curl 验证

建会话，拿到 `id`：

```bash
curl -s -X POST http://127.0.0.1:8787/sessions -H "Content-Type: application/json" -d "{}"
```

发一条消息，看 SSE 流（会依次出现 `tool_call` / `permission` / `tool_result` / `delta` / `done` 事件）：

```bash
curl -N -X POST http://127.0.0.1:8787/sessions/<id>/messages \
  -H "Content-Type: application/json" \
  -d '{"message":"please read README.md and write a note about it"}'
```

这条消息会让假模型依次调用 `now`、`read_file`、`write_note`，其中 `write_note` 会过一次权限门。

看历史（已经落盘的内容）：

```bash
curl -s http://127.0.0.1:8787/sessions/<id>/history
```

一次性拿到结果（不流式），错误会带合适的 HTTP 状态码（取消是 200，401 是 401，400 是 400，不会是清一色 500）：

```bash
curl -s -X POST "http://127.0.0.1:8787/sessions/<id>/messages?stream=0" \
  -H "Content-Type: application/json" -d '{"message":"what time is it now?"}'
```

让假模型直接回一个错误码，验证应用的错误处理：

```bash
curl -s -X POST "http://127.0.0.1:8787/sessions/<id>/messages?stream=0" \
  -H "Content-Type: application/json" -d '{"message":"[status:401] test"}' -i
```

演示取消：发一条带 `slow` 的消息，几秒内另一个终端调 stop。

```bash
curl -N -X POST http://127.0.0.1:8787/sessions/<id>/messages \
  -H "Content-Type: application/json" -d '{"message":"slow please read README.md"}'

curl -s -X POST http://127.0.0.1:8787/sessions/<id>/stop -H "Content-Type: application/json" -d "{}"
```

> Windows PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，要写 `curl.exe`，并且内联 JSON 的引号会被
> PowerShell 吃掉。稳妥做法是把请求体写进一个文件，再 `curl.exe -d "@body.json"`。

## 换成真实模型

不用改代码，设三个环境变量（可再加 `PROTOCOL`）：

```bash
BASE_URL=https://你的中转站/v1 API_KEY=sk-xxx MODEL=gpt-4o-mini bun run examples/app/server.js
```

只设了 `BASE_URL` 才会用真模型；否则一直用假模型。

## 哪些是包不做的，要应用层自己做

包本身只负责：驱动循环、执行工具（文件工具跑子进程）、维护 history 的格式、裁剪上下文、压缩、重试、适配四种模型协议（OpenAI Chat / Responses / Anthropic / Gemini）。

下面这些**包不做**，都由这个示例里的应用层代码承担，你的项目也要自己做：

- **会话归属**：谁拥有哪个会话、id 怎么分配、多用户怎么隔离、同一会话并发发消息怎么排队。
- **持久化**：history 只是内存数组，包不落盘、也不删。存哪里、什么时候存、怎么恢复、媒体块怎么复原，都是你的事。
- **流式转发**：把 `onLLMEvent` / `onStep` 的增量送到你的前端（SSE、WebSocket 或轮询）。
- **权限策略**：哪些工具要问、问谁、拒绝后怎么办、决定怎么留痕。
- **观测与告警**：耗时、token 用量、工具失败率、错误上报。
- **取消的产品行为**：取消算不算失败、取消后历史里留下什么、客户端断线要不要顺手停。
- **生产限额**：工具输出上限、并发上限、请求超时、重试预算、上下文预算、最大轮数。
- **密钥管理**：`apiKey` 怎么存、怎么轮换，别写进代码或日志。
- **模型与协议**：地址、协议、模型选择；换模型不会破坏 history，但要你自己决定何时换。

## 注意

- `.data/` 是本机运行产生的会话历史，已加入 `.gitignore`，不进版本库。
- 假模型只认关键字（`now` / `read` / `write` / `slow` / `[status:数字]`），不懂真正语义，只是为了把每一步稳定走一遍。
- SSE 事件类型：`delta`（文字增量）、`llm`（模型返回，带耗时和 usage）、`tool_call` / `tool_result`、`permission`、`step`、`compact`、`done`（正常结束）、`aborted`（被取消）、`error`（出错，带 `kind`）。
