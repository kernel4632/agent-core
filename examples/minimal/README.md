# minimal —— 离线可跑的最小 agent

运行：

```bash
bun examples/minimal/main.ts
```

`main.ts` 用 `Bun.serve` 起了一个假的 OpenAI 兼容模型（不需要 API 密钥），把 `tools/` 目录的路径交给 Agent，
模型调用 `say_hello` 时工具在子进程里执行；`send` 的第二个参数传入 `onToolResult` 观察工具结果，最后打印回答和结束原因。
整条链路就是核心循环：问模型 → 执行工具 → 再问模型。
