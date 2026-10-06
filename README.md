# @kernel4632/agent-core

[![CI](https://github.com/kernel4632/agent-core/actions/workflows/ci.yml/badge.svg)](https://github.com/kernel4632/agent-core/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kernel4632/agent-core)](https://github.com/kernel4632/agent-core/releases/latest)

一个轻量的 AI Agent 核心包。给它一个 LLM 地址和一些工具（工具文件目录，或内存里的工具对象），它就能自动循环"问模型 → 执行工具 → 再问模型"，直到任务完成。

---

## 目录

- [这个包是干什么的](#这个包是干什么的)
- [核心设计：为什么是它](#核心设计为什么是它)
- [安装](#安装)
- [5 分钟快速上手](#5-分钟快速上手)
- [三种用法：从纯聊天到接 MCP 和技能](#三种用法从纯聊天到接-mcp-和技能)
- [接入 MCP 和技能](#接入-mcp-和技能)
- [项目架构](#项目架构)
- [自定义工具：从零到完整](#自定义工具从零到完整)
- [API 参考](#api-参考)
- [上生产前](#上生产前)
- [可观测性](#可观测性)
- [示例](#示例)
- [长跑压测](#长跑压测)
- [运行测试](#运行测试)
- [打包成单文件](#打包成单文件)
- [这个包不做什么](#这个包不做什么)
- [常见问题](#常见问题)

---

## 这个包是干什么的

你可以把它理解成一个"AI 大脑驱动引擎"：

```mermaid
flowchart TD
    app["你的程序"] --> create["Agent.create()<br/>创建实例"]
    create --> send["agent.send()<br/>发送指令"]
    send --> loop["Loop<br/>自动循环"]
    loop --> llm["LLM<br/>问模型"]
    loop --> tool["Tool<br/>执行工具"]
    tool --> loop
```

模型每次回复要么"调用某个工具"，要么"我做完了"。这个包负责把这个循环跑起来，你只需要写工具文件就行。

---

## 核心设计：为什么是它

两件事是这个包真正想做的，别的都围着它们转。**看清这两条，就理解了这个包的全部取舍。**

### 一、独特的 Agent 循环

循环骨架很简单（建上下文 → 问模型 → 要调工具就执行再回上去），难的是**什么时候停下来**。这个包在"停"这件事上有几个和别人不一样的决定。

```mermaid
flowchart TD
    A["建上下文<br/>（太长先压缩一次）"] --> B["问一次模型"]
    B --> C{"模型要调工具？"}

    C -->|要| D["并行执行所有工具"]
    D --> E["结果写回 history"]
    E --> S{"有工具返回<br/>stop:true？"}
    S -->|是| T1["返回 tool-stop"]
    S -->|否| T2{"步数到 maxSteps？"}
    T2 -->|是| T3["返回 step-limit"]
    T2 -->|否| A

    C -->|不要| F{"结束判定"}
    F -->|结构化输出成功<br/>或没注册工具| R1["返回 finished"]
    F -->|步数到 maxSteps| T3
    F -->|连续不调工具<br/>达 noToolRounds| R2["返回 no-tool"]
    F -->|还没到| P["继续下一轮<br/>（末轮前插一句提醒）"]
    P --> A
```

**① 模型不调工具，不会立刻结束。** 很多模型在任务没做完时会"礼貌地"给一段总结就停下。直接结束会把没干完的活丢掉。所以有工具时，模型不调工具会先**临时**插一句提醒（`noToolPrompt`）再问一次，连续 `noToolRounds` 轮（默认 3）都不调才结束。这句提醒只挂在那一次请求上，**不写进 `history`**。不想要这个行为，把 `noToolRounds` 设成 `Infinity`。

**② `history` 是唯一的权威数据来源，只增不删。** 循环从不修改历史，模型消息、工具结果按发生的顺序追加。连压缩也只追加一条总结。原因：`history` 归你的应用所有（存库、渲染、多会话），核心替它丢弃数据是不可逆的错误——该留多少由持有它的你决定。

**③ 一轮里的工具并行执行。** 模型经常一次要求调好几个工具；串行会让任务慢好几倍。所以同一轮的工具同时开跑，结果按原顺序收齐再写回历史。每个工具独占一个子进程，所以死循环的工具能被一刀杀掉，崩溃的工具不会拖垮 Agent。

**④ 每次 `send` 只跑一个任务，"最新指令优先"。** 新的 `send` 会先停掉上一个（同一次 tick 里发出的请求，后者一定看得见前者并把它停掉）。原因：一台 Agent 只有一份 `history`，两个任务同时写会乱序。

**⑤ 每个出口都补一条模型能读的结果。** 取消 → 一条"已中断"结果；工具失败 → 一条错误结果；模型点了不存在的工具 → 一条"调用无效"结果。**绝不留下"有调用、没结果"的残缺记录**。原因：这种残缺序列会被 OpenAI / Anthropic 直接 400，而 `history` 只增不删，一次残缺就永久毒死这个会话，重启装回历史也一样。

### 二、独特的上下文压缩保留方案

大多数做法是"上下文满了就丢掉旧消息"。这个包**不丢，只追加总结**——它改的是"这一次发给模型的内容有多大"，不是"历史能留多少"。

`history` 里原文一条不少；每次发请求时，只从里面**现挑**该带哪些回合：

| history 里的位置 | 内容 | 这一次发给模型吗 |
|------------------|------|------------------|
| 最初 | 用户最初的目标 | 保留：最多 3 个用户回合、≤20% 预算 |
| 中段 | 更早的回合 | 已被总结覆盖，不再单独发 |
| 总结 | 最新一条 `compact` 总结 | 折进 `system`（不是当消息） |
| 总结前 | 最近的现场回合 | 保留：最多 3 个回合、≤30% 预算 |
| 总结后 | 之后的全部新回合 | 全部保留（当前正在推进的） |

几个关键取舍，以及为什么：

- **裁剪的最小单位是「回合」，不是「消息」。** 一个回合 = 用户一次发言，或模型的一次响应连同它发起的全部工具调用和结果。工具结果按 `toolCallId` 回到发起它的回合，**同进同出**。所以裁剪结果永远不会切断"调用 / 结果"的配对——那种残缺会被供应商 400。
- **最新那条总结折进 system，而不是当成一条消息塞进对话。** 裸的 `role:'user'` 总结会被模型读成"用户塞给我一张表"，于是从头重做整个任务。实测 `gpt-oss-120b` 折进 system 前只有 1/6 能正确接着做，之后 6/6。
- **总结里保留最初目标。** 挑内容时，最初那几轮用户发言（说不出的话）单独钉住，最多 3 个回合、占 20% 预算。就算预算装不下，总结本身也被要求保留"用户最初的目标"，而总结在 `system` 里永远不会被裁掉。
- **二次压缩不会忘掉上一次的总结。** 压缩请求会把上一版总结作为"背景"并进提示词，新总结必须保留其中仍然有效的事实。直接丢掉旧总结，会越压越忘。
- **按预算保留，不按条数。** 用户第一条消息就粘一大段日志时，只按条数留会让压缩永远收敛不了（实测 120/120 轮压完仍超阈值）。所以旧内容按预算分：目标 20%、最近现场 30%。
- **每轮最多压一次。** 不为"压到达标"而连续调用模型——那样一轮能烧掉上千次请求（实测）。压完还超限就照常发出去，由服务端判断；下一轮还超自然会再压一次。

> 一句话：**history 永不删、总结折进 system、裁剪按回合。** 这三条一起保证——发给模型的永远是合法上下文，模型永远能"接着做"而不是"重做"，而你的完整历史一条都没丢。

---

## 安装

这个包需要 [Bun](https://bun.sh) 运行时（不支持 Node.js）。

从 npm 安装：

```bash
bun add @kernel4632/agent-core
```

想锁死某个版本（比如 `0.24.18`），在包名后写版本号：

```bash
bun add @kernel4632/agent-core@0.24.18
```

也可以从 GitHub Release 安装，永远拿到最新版：

```bash
bun add https://github.com/kernel4632/agent-core/releases/latest/download/agent-core.tgz
```

想锁死某个 GitHub 版本，把链接里的 `latest/download` 换成 `download/v0.24.18`：

```bash
bun add https://github.com/kernel4632/agent-core/releases/download/v0.24.18/agent-core.tgz
```

以后升级到最新版，再运行一次安装命令就行。

---

## 5 分钟快速上手

### 第一步：写一个工具文件

新建 `tools/say-hello.js`：

```js
export default {
    name: 'say_hello',                         // 工具名，模型通过这个名字调用它
    description: '向指定的人打招呼',             // 告诉模型这个工具是干什么的
    inputSchema: {                             // 描述模型需要传哪些参数
        type: 'object',
        properties: {
            name: { type: 'string', description: '要打招呼的人的名字' },
        },
        required: ['name'],
    },
    async execute(input) {                     // 真正执行的函数，input 就是模型传来的参数
        return `你好，${input.name}！`          // 返回值会原样告诉模型
    },
}
```

### 第二步：创建 Agent 并发送指令

新建 `main.js`：

```js
import Agent from '@kernel4632/agent-core'

// 一行拿到工具：目录、内存工具（MCP / AI SDK）可以任意搭配
const tools = await Agent.tool.from('./tools')

// 创建一个 Agent 实例
const agent = Agent.create({
    config: {
        baseURL: 'https://你的模型地址/v1',    // OpenAI 兼容接口地址
        apiKey: 'sk-你的密钥',
        model: '模型名称',
        system: '你是一个助手，请使用工具完成用户的任务。',
    },
    tools,                                    // 把扫描好的工具传进来
    callbacks: {
        onToolResult: result => {             // 工具执行完时的回调
            console.log('工具执行完了:', result.toolName, result.output)
        },
    },
})

// 发送指令，等待完成
const result = await agent.send('帮我向小明打个招呼')
console.log('Agent 结束，原因:', result.reason)   // 有工具时通常是 'no-tool'：模型停手后还会被追问最多 noToolRounds 轮（默认 3）才结束
```

> 上面这个例子里注册了工具，所以模型就算一次就把话说完了，`send` 也不会立刻返回——它会连续几轮确认模型真的不再用工具（这是这个包循环的特点，避免模型过早收手）。想一停手就结束，设 `noToolRounds: 1`；想明确收尾，写一个返回 `stop: true` 的 `finish` 工具。

运行：

```bash
bun main.js
```

---

## 三种用法：从纯聊天到接 MCP 和技能

先看清自己属于哪一种，再往下读：

| 你想做什么 | 怎么写 | 去哪看 |
|------------|--------|--------|
| 只聊天，不用工具 | `Agent.create({ config })` 然后 `agent.send('...')` | 上面的快速上手 |
| 用普通工具（自己写的文件） | `tools = await Agent.tool.from('./tools')`，传给 `create` | 「自定义工具」「`Agent.tool`」 |
| 用 MCP 工具、用技能（skills） | 应用自己连 MCP、读技能，再用 `Agent.tool.from(...)` 汇进来 | 下一节「接入 MCP 和技能」 |

一句话记住：**这个包只负责"循环 + 执行工具"**。MCP 的连接、技能的读取都不是它的事——你把它们变成普通工具对象交进来就行。

---

## 接入 MCP 和技能

MCP 和技能（skills）都由**你的应用**负责，核心只接收通用工具对象。两者的做法一样：先拿到"工具对象"，再交给 `Agent.tool.from`。

```mermaid
flowchart TD
    f["文件工具<br/>./tools"] --> from["Agent.tool.from(...)"]
    m["MCP 工具<br/>mcp.tools()"] --> from
    s["技能工具<br/>skills.readTool()"] --> from
    from --> agent["Agent.create(...)"]
```

### 接 MCP

MCP 是"模型调用外部服务"的标准协议。用官方客户端 `@ai-sdk/mcp` 连上服务后，它给出的工具对象**直接就能用**，不需要任何包装：

```js
import { createMCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport as Stdio } from '@ai-sdk/mcp/mcp-stdio' // stdio 传输要从子路径导入

// 连接由你的应用管理：什么时候连、连哪个、什么时候关
const mcp = await createMCPClient({
    transport: new Stdio({ command: 'bun', args: ['./mcp-server.js'] }),
})

const tools = await Agent.tool.from('./tools', mcp.tools())   // 就这一句
const agent = Agent.create({ config, tools })

// ... 用完后
await mcp.close()
```

> MCP 工具的返回值（文字、图片）会自动转成模型能读的块。想自己改写，见「`Agent.tool.adopt`」。

### 接技能（skills）

技能是"现成的操作步骤"：一个文件夹放一份 `SKILL.md`，开头写名字和说明，下面是正文。约定见 [agentskills.io](https://agentskills.io)。

```
skills/
└── review-pr/
    └── SKILL.md      # 开头是 name 和 description，下面是步骤正文
```

社区有现成的库负责**读取和校验**这些文件，比如 `agent-skills-ts-sdk`。它给你两样东西：一段"技能清单"（放进 `system` 让模型知道有哪些技能）和一个"按需读正文"的工具。扫描、组装仍由你写，就是下面这几行：

```js
import { createSkillRegistry, skillSourceFromEntries } from 'agent-skills-ts-sdk'

const sources = []
for await (const file of new Bun.Glob('skills/*/SKILL.md').scan()) {
    sources.push(skillSourceFromEntries(
        [{ name: 'SKILL.md', content: await Bun.file(file).text() }],
        { id: file, location: file },
    ))
}
const skills = await createSkillRegistry(sources)
const decl = skills.readTool()          // 技能清单 + 一个"读正文"的工具声明

const skillTool = {
    description: decl.description,
    inputSchema: decl.parametersJsonSchema,
    execute: async args => {
        const r = await skills.read(args)
        return r.ok ? r.content : { output: { type: 'error-text', value: r.error } }
    },
}

// 清单进 system，正文等模型需要时用 skill 工具读
const system = ['你是一个编程助手。', skills.systemPrompt()].filter(Boolean).join('\n\n')
const tools = await Agent.tool.from({ [decl.name]: skillTool })
const agent = Agent.create({ config: { ...config, system }, tools })

await agent.send('按 review-pr 技能审查这个改动')
```

### MCP 和技能一起用

一次性汇进去就行：

```js
const tools = await Agent.tool.from(
    './tools',                          // 文件工具
    mcp.tools(),                        // MCP 工具
    { [decl.name]: skillTool },         // 技能加载工具
)
```

<details>
<summary>不想引库？自己读 SKILL.md 也就十几行</summary>

`SKILL.md` 的开头是一小段用 `---` 包起来的说明（`name` 和 `description`），下面是正文。自己切开即可：

```js
const skills = {}
for await (const path of new Bun.Glob('skills/*/SKILL.md').scan()) {
    const text = await Bun.file(path).text()
    const name = text.match(/name:\s*(.+)/)?.[1]?.trim()
    const description = text.match(/description:\s*(.+)/)?.[1]?.trim()
    const body = text.replace(/^---[\s\S]*?---/, '').trim()   // 去掉说明段，只留正文
    if (name) skills[name] = { description, body }
}

const names = Object.keys(skills)
const system = names.length
    ? '可用技能（需要时用 skill 工具读正文）：\n' + names.map(n => `- ${n}：${skills[n].description}`).join('\n')
    : ''

const skillTool = {
    skill: {
        description: '按名字读取一个技能的完整步骤',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        execute: async ({ name }) => {
            if (!Object.hasOwn(skills, name)) throw new Error(`没有技能 ${name}`)
            return skills[name].body
        },
    },
}

// 拼装：提示词进 system，读正文的工具进 tools
const tools = await Agent.tool.from('./tools', skillTool)
const agent = Agent.create({ config: { ...config, system: ['你是一个助手。', system].filter(Boolean).join('\n\n') }, tools })
```

完整约定（frontmatter 字段、目录名等于技能名、正文按需加载）见 [agentskills.io](https://agentskills.io)。想要省事就直接用上面的 `agent-skills-ts-sdk` 之类的库。

</details>

---

## 项目架构

```
@kernel4632/agent-core
│
├── index.js              ← 唯一入口：create / send / stop / compact，把下面的功能组合起来
│
├── features/             ← 功能：由入口或主循环组合起来用，每个文件一个主体
│   ├── loop.js           ← 主循环：Context → TextTools → LLM → 工具 → ...
│   ├── llm.js            ← 只负责和模型说话：四种协议、缓存、超时、错误分类
│   ├── text-tools.js     ← 文字工具协议：让纯对话模型也能调用工具
│   ├── history.js        ← 对话记录：造消息块、拆回合、渲染
│   ├── context.js        ← 把历史消息裁剪成这一轮发给模型的上下文
│   ├── compact.js        ← 上下文太长时写总结
│   ├── tool.js           ← 工具：扫描文件工具、接纳内存工具、执行、合并（主线程这一半）
│   └── tool-process.js   ← 文件工具真正跑起来的地方（子进程那一半）
│
└── utils/                ← 工具：被功能调用，不反过来依赖功能
    ├── retry.js          ← 失败自动重试（指数退避）
    ├── notify.js         ← 所有回调的统一出口
    ├── schema.js         ← 工具参数格式归一化（scan 和 adopt 共用）
    ├── shape.js          ← 工具返回值变成输出块（内存工具用；子进程里有一份副本）
    └── tokens.js         ← 上下文 token 估算：字符数 × 每字符 token 比，比例由真实 usage 自校准
```

`tool.js` 和 `tool-process.js` 是同一件事的两半，所以放在一起：前者在主线程里找工具、管工具进程，
后者被前者当成文本内联、在独立的 bun 子进程里加载并执行工具。分成两个文件是平台限制，不是分层。

**工具进程隔离的是生命周期，不是环境。** 工具在里面拥有和 Agent 完全相同的权限：读写任意文件、执行任意命令、联网、读到父进程的全部环境变量。这是有意的——电脑任务 agent 的工具本来就得能干这些。它真正隔离的是四样：**失控**（死循环工具能被一刀杀掉，实测 0ms）、**崩溃**（工具死了 Agent 继续跑）、**内存**（独立堆）、**Agent 状态**（工具碰不到 `history`、`config`、`running`）。

**为什么用子进程而不是 Worker 线程**：Worker 被 `terminate()` 之后 Bun 不归还它占的约 22MB，
而且杀线程带不走它 `Bun.spawn` 出来的孙进程。常驻 agent 天天要杀工具进程（工具崩溃、超时、用户打断），
两笔账会一直累积。换成子进程之后实测 200 次「起→用→杀」主进程只涨 2MB（Worker 版是 4.4GB），
孙进程一起带走，主进程退出时工具进程也全部跟着死。复用时单次调用 0.08ms，比 Worker 还快。

### 数据流

```mermaid
flowchart TD
    send["agent.send(input)"] --> hu["History.user()"]
    hu --> ctx["Context.build()<br/>裁剪上下文"]
    ctx --> llm["LLM.chat()<br/>请求模型"]
    llm --> q{"模型要调工具？"}
    q -->|要| te["Tool.execute()<br/>并行执行"]
    te --> wr["结果写入 history"]
    wr --> ctx
    q -->|不要| done["结束判定<br/>（分支见「核心设计」）"]
```

---

## 自定义工具：从零到完整

### 最简单的工具

```js
// tools/add.js
export default {
    name: 'add',
    description: '把两个数字加在一起',
    inputSchema: {
        type: 'object',
        properties: {
            a: { type: 'number' },
            b: { type: 'number' },
        },
        required: ['a', 'b'],
    },
    async execute(input) {
        return input.a + input.b    // 直接返回结果
    },
}
```

### 带流式输出的工具

工具可以用 `yield` 逐步返回内容，适合耗时较长的操作：

```js
// tools/count.js
export default {
    name: 'count',
    description: '从 1 数到 n，逐步输出',
    inputSchema: {
        type: 'object',
        properties: { n: { type: 'number' } },
        required: ['n'],
    },
    async *execute(input) {               // 注意：async * 是异步生成器
        for (let i = 1; i <= input.n; i++) {
            yield `数到了 ${i}`           // 每次 yield 都会立刻发给上层的 onOutput 回调
            await new Promise(r => setTimeout(r, 100))
        }
    },
}
```

文件工具和内存工具都支持 `async *execute`（`Agent.tool.adopt` 接纳的内存工具也一样）。接收流式输出：

```js
const agent = Agent.create({
    // ...
    callbacks: {
        onToolOutput: output => {
            console.log('实时输出:', output.data)   // 每次 yield 触发一次
        },
    },
})
```

### 调用子进程的工具

工具在独立子进程里运行，`Bun.spawn` 的 stdout/stderr 会自动转发给 `onToolOutput`，不需要额外处理：

```js
// tools/run-script.js
export default {
    name: 'run_script',
    description: '运行一个 shell 脚本',
    inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
    },
    async execute(input) {
        const proc = Bun.spawn(['bash', '-c', input.command], {
            stdout: 'pipe',
            stderr: 'pipe',
        })
        await proc.exited
        return { exitCode: proc.exitCode }   // stdout/stderr 已经自动转发了
    },
}
```

### 一个文件导出多个工具

```js
// tools/math.js
const add = {
    name: 'add',
    description: '加法',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    async execute(input) { return input.a + input.b },
}

const multiply = {
    name: 'multiply',
    description: '乘法',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    async execute(input) { return input.a * input.b },
}

export default [add, multiply]    // 导出数组
```

工具是按**名字**找到的，不是按它在数组里排第几。所以往文件里插入新工具、调换顺序都不会让模型调错工具。

### 工具目录里可以放共享代码

扫描时只把"形状对得上"（有 `name`、有 `execute`）的东西注册成工具，其余文件直接跳过。
所以下面这些都可以和工具放在同一个目录里，不会影响扫描：

```
tools/
├── read.js          ← 工具
├── write.js         ← 工具
├── shared.js        ← 共享辅助函数，没有默认导出，自动跳过
└── read.test.js     ← 测试文件，自动跳过
```

跳过的前提是这些文件**能被加载**。目录里任何一个 `.js` 有语法错误、或者 import 了装不上的依赖，
`scan` 会当场抛出来——这是有意的：工具目录是你自己的代码，坏了就该立刻知道，
静默跳过只会变成"某个工具莫名其妙不见了"。

### 主动停止 Agent 的工具

如果某个工具代表"任务完成"，可以让它返回 `stop: true`，Agent 循环会立刻停止：

```js
// tools/finish.js
export default {
    name: 'finish',
    description: '任务完成时调用这个工具',
    inputSchema: {
        type: 'object',
        properties: { summary: { type: 'string', description: '完成情况总结' } },
        required: ['summary'],
    },
    async execute(input) {
        return {
            stop: true,                        // 告诉 Loop 停止循环
            output: { type: 'text', value: input.summary },
        }
    },
}
```

### 返回图片的工具

工具可以直接返回一个成形的输出块。截图、生成图表这类工具就靠这个把图交给模型：

```js
// tools/screenshot.js
export default {
    name: 'screenshot',
    description: '截取当前屏幕',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
        const png = await grabScreen()          // 你自己的截图实现，拿到 base64
        return {
            output: {
                type: 'content',                // 多模态输出块
                value: [
                    { type: 'text', text: '当前屏幕：' },
                    { type: 'file', mediaType: 'image/png', data: { type: 'data', data: png } },
                ],
            },
        }
    },
}
```

`content` 块里只能放 `text` / `file` / `file-data` / `file-url`，以及旧写法 `image` / `audio` / `video`（发出前会自动转成 `file`）。放别的（比如旧版 AI SDK 的 `media`）会被工具进程当场挡住、变成一条普通的工具失败——这是有意的：非法块一旦穿过去写进 `history`，AI SDK 会在本地校验时抛错、请求根本发不出去、重试也认不出来，而 `history` 只增不删，于是之后每次 `send` 都撞同一堵墙，重启装回历史也一样。

`output` 里给的块会被原样交给模型，不会再被套一层。`maxToolOutput` 的截断**只作用于文字块**——图截一刀就彻底废了，所以媒体内容一个字节都不动。

### 工具权限询问

在敏感操作前可以要求用户确认：

```js
const agent = Agent.create({
    // ...
    callbacks: {
        onPermission: async ({ toolName, input: args }) => {
            // 只有 delete_file 工具需要确认
            if (toolName === 'delete_file') {
                console.log(`即将删除文件: ${args.path}`)
                // 实际项目里这里可以弹窗或读取用户输入
                return true    // 返回 true 允许，false 拒绝
            }
            return true        // 其他工具直接放行
        },
    },
})
```

---

## API 参考

### `Agent`

从包里导入的唯一入口：

```js
import Agent from '@kernel4632/agent-core'
```

#### `Agent.create(options?)`

创建一个独立的 Agent 实例，多个实例互不影响。

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.id` | `string` | Agent ID，默认自动生成 |
| `options.history` | `array` | 初始历史消息，默认 `[]` |
| `options.config` | `object` | 模型配置，见下表 |
| `options.tools` | `object \| array` | `scan()` / `adopt()` 的返回值，也可以直接传工具对象数组或 record，会自动归一化 |
| `options.callbacks` | `object` | 回调函数集合，见下表 |

**`config` 字段：**

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `baseURL` | `''` | 模型服务地址；`model` 是字符串时必填 |
| `apiKey` | `''` | 本包创建模型连接时使用的 API 密钥 |
| `model` | `''` | 模型名称（需要 `baseURL`），或 AI SDK 创建的模型实例（自带连接配置） |
| `protocol` | `'chat'` | 本包创建模型连接时使用的协议：`chat` / `responses` / `anthropic` / `gemini` |
| `system` | `''` | 系统提示词 |
| `stream` | `true` | 是否流式请求模型。默认流式，`await send` 仍拿到完整结果；设为 `false` 才走非流式的旧式请求 |
| `cache` | `true` | 提示词缓存，默认开启。长会话的固定开头（system、工具、历史）会被服务端缓存，命中就是省时间和省钱 |
| `toolMode` | `'native'` | 默认只用原生工具，system 零注入。接纯对话模型时主动打开 `'text'`（模拟工具）或 `'auto'`（兼容降级），见下方「让没有原生工具的模型也能用工具」 |
| `capabilities` | 见下方 | 按模型能力逐项开关图片、音频、视频、文件、工具调用、结构化输出、toolChoice、思考内容和流式用量 |
| `mediaFallback` | `'error'` | 媒体能力关闭时的处理方式；改成 `'strip'` 后保留文字并丢掉不支持的媒体 |
| `provider` | `{}` | AI SDK 的生成参数，整份交给 AI SDK；不设时用模型自己的默认值 |
| `maxToolOutput` | `undefined` | 默认不截断工具输出；主动设置后超出部分从中间截断并告知模型 |
| `maxTokens` | `128000` | 上下文预算，**默认开启自动压缩**：估算的上下文超过预算的 `compactThreshold` 比例时就压缩一次。设 `Infinity` 关闭。注意区别于 `provider.maxOutputTokens`（那是单次生成上限） |
| `compactThreshold` | `0.8` | 压缩触发比例，0.8 表示到达 80% 时压缩 |
| `compact` | `undefined` | 压缩单独用一套模型时写在这里，例如 `{ model: '便宜的小模型' }`；不写就和主模型共用 |
| `output` | `undefined` | 结构化输出格式，例如 `Agent.output.object({ schema })`；不写就返回普通文字 |
| `maxSteps` | `undefined` | 默认不限制模型轮数；主动设置正整数后，到上限先保存这一轮的工具结果，再返回 `step-limit` |
| `maxToolConcurrency` | `undefined` | 默认不限制**文件工具**的并发；主动设置后超出的排队。内存工具（`Agent.tool.adopt` / MCP）在主进程直接跑，不受这个上限约束 |
| `retryBaseDelay` | `5000` | 第一次退避的基数（毫秒），之后每次 ×2：5s、10s、20s…（照抄 Roo Code） |
| `retryMaxDelay` | `600000` | 单次退避上限（毫秒），到顶就按这个值等待、不再增长（默认 10 分钟，照抄 Roo Code） |
| `retryMaxElapsed` | `undefined` | 默认不限重试总时长；主动设置毫秒数后，到点把错误交给上层 |
| `retry` | `undefined` | 调用方过滤不想重试的错误，见下方「重试规则」。不设＝默认全重试 |
| `requestTimeout` | `undefined` | 默认不限制单笔请求时长；主动设置毫秒数后，卡住的一笔会被中断 |
| `noToolPrompt` | 一条"请继续使用工具"的提醒 | 有工具但模型连续不调时，在结束前一轮临时发给模型；只挂在那一次请求上，不写进 `history`。设成 `''` 就不提醒 |
| `noToolRounds` | `3` | 有工具时，连续多少轮不调工具就结束一次 `send`；设成 `1` 就是模型不调工具即结束，设成 `Infinity` 就永不因不调工具结束。没注册工具时一轮就结束，不受它影响 |

### 重试规则

失败的重试由底层统一处理，默认行为照抄 Roo Code：**除"取消"和"上下文超长"外，任何错误都会重试**（401、400、格式错误都算），次数不限，也不设总时长上限；退避按 `retryBaseDelay × 2` 增长，单次最长到 `retryMaxDelay` 封顶。上下文超长不走重试，而是先压缩上下文再重发这笔请求，最多 3 次。取消（`agent.stop()` 或传 `signal`）永远不重试。

想收口或过滤，用三个配置：

```js
const agent = Agent.create({
    config: {
        retryBaseDelay: 5000,      // 第一次等待 5s，之后 10s、20s…（默认）
        retryMaxDelay: 600000,     // 单次等待最多 10 分钟（默认）
        retryMaxElapsed: 120000,   // 一直失败最多再试 2 分钟，到点把错误交给上层（默认不限）
        // 只对"不想重试的错误"下手，命中即不重试：
        retry: {
            skipCodes: [400, 401],       // 按状态码
            skipKinds: ['auth'],         // 按 error.kind：aborted/auth/limit/timeout/server/network/request/unknown
            skipText: /invalid api key/i, // 按报错文字（字符串或正则）
            shouldRetry: error => error.statusCode !== 422, // 自定义判断，返回 false＝不重试
        },
        // retry 也可以直接传一个函数：(error) => boolean，返回 false＝不重试
    },
})
```

`retry` 属于 **整份替换**（和 `provider` 一样，本次传了就用本次的整份，不与上次合并）。

陌生中转站建议先使用默认能力。遇到只支持文字、但接口声称兼容 OpenAI 的模型，可以按能力关闭：

```js
const agent = Agent.create({
    config: {
        baseURL: 'https://api.example.com/v1', model: 'model-name',
        capabilities: {
            image: false, audio: false, video: false, file: false,
            tools: false, structuredOutput: false, toolChoice: false,
            reasoning: false,
        },
        mediaFallback: 'strip',
    },
})
```

`image`、`audio`、`video` 和 `file` 控制内容块；`tools` 控制是否发送工具描述；`structuredOutput` 控制是否发送 `response_format`；`toolChoice:false` 让请求省略 `tool_choice`（只对字符串模型 + `chat`/`responses`/`anthropic` 完整生效；`gemini` 按自身默认、不强制；传模型实例时会报错，因为它需要改写请求体）；`reasoning:true` 才会把历史里的思考块发给模型；`usage:false` 关掉流式请求里的 `stream_options.include_usage`（个别不认这个字段的中转站会 400，关掉即可，代价是 token 估算拿不到真实数据、只能靠粗估）。旧式 `image`、`audio`、`video` 内容块会在真正请求模型时转换成 AI SDK 当前使用的 `file`，历史数组仍保留原始形状。

`provider` 直接放 AI SDK 的生成参数，例如：

```js
const agent = Agent.create({
    config: {
        baseURL: 'https://api.example.com/v1', apiKey: 'sk-xxx', model: 'model-name',
        provider: {
            temperature: 0.3, topP: 0.9, maxOutputTokens: 4096,
            toolChoice: 'auto',                 // 默认 auto；不传时由底层使用 auto
            providerOptions: { openai: {} },    // 厂商专用设置直接交给 AI SDK
            headers: { 'X-App': 'example' },    // 额外请求头
            body: { custom_field: true },      // 额外请求体字段
        },
    },
})
```

在 `agent.send({ input, config: { ... } })` 里传入的配置会**写回 Agent**、之后的 send 继续生效。合并规则分三种：`provider` 和 `retry` **整份替换**（传了就只用新的，未写的字段不再保留）；`capabilities` 和 `compact` **按字段浅合并**（只传其中一项不丢另外的）；其余字段直接覆盖。`maxTokens` 是上下文预算，和 `provider.maxOutputTokens`（单次生成量）不是一回事。

`cache` 默认开启。四种协议各按自己的方式让服务端复用固定的开头（system、工具描述、历史），命中后那部分不再重新计算，长会话能明显变快、变便宜：

| 协议 | 发的字段 |
|------|----------|
| `chat` / `responses` | `prompt_cache_key`，服务端按这个键把同一台 Agent 的连续请求路由到同一处缓存 |
| `anthropic` | 在 system 和最后一条消息上打 `cache_control` 断点；Anthropic 不会自动缓存，不打就是 0% |
| `gemini` | 隐式缓存由服务端自己决定，请求里没有可发的字段 |

实测（同一会话的多步工具循环，默认配置）：`chat` 从第二步起命中约 99%，整个任务约 80%；`anthropic` 从第三步起每步命中整段开头，整个任务约 60%。键默认由 `baseURL + model + system` 推出，同一台 Agent 的连续请求自然落在同一个键上。也可以传对象自定义：

```js
cache: {
    key: 'project:conversation-1',
    retention: '1h',
    body: { cache_namespace: 'agent' },
}
```

个别中转站不认这组字段、直接返回 400，那时设 `cache: false` 关掉，或把供应商自己的字段放进 `provider.body`。

#### 让没有原生工具的模型也能用工具

有的中转站模型只会对话：请求里一带 `tools` 字段就报错。也有的模型接口支持工具，模型自己却不会用，把调用当成一段文字写了出来。这两种情况各有一个兼容开关，**默认都关着**：

| `toolMode` | 行为 | 会不会改 system |
|------------|------|----------------|
| `'native'`（默认） | 只用原生工具字段，文字里的调用一律当成普通回答 | 不会，你写的 system 原样发出 |
| `'text'` | 模拟工具：不发 `tools` 字段，把工具说明写进 system，从模型的文字里读回调用 | 会，追加一段工具说明 |
| `'auto'` | 兼容降级：先用原生工具；接口拒收工具字段时，改用文字协议重发，并记住这个模型；模型没走原生调用、却在文字里写了调用时，也读出来执行 | 只在被拒收、改用文字协议之后才会 |

这个包的原则是**默认零注入**：不打开开关，发给模型的 system 就是你写的那段，一个字都不多。接特殊 API 时缺什么就打开什么。

文字协议的格式（参考 Roo Code / Cline 的文本工具调用）：

```
<tool_call>
{"name": "add", "arguments": {"a": 1, "b": 2}}
</tool_call>
```

工具结果用 `<tool_result name="add">…</tool_result>` 作为一条 user 消息送回模型。读取时尽量宽容：一次回复里写多个调用、`arguments` 写成字符串、外面套一层 `{"type":"function","function":{…}}`、参数平铺在同一层、带 Markdown 代码围栏、多一个尾逗号、最后一块没闭合，都能读出来。Roo Code 风格的 XML 写法（`<read_file><path>a.js</path></read_file>`）也认，会按工具的 schema 把 `"7"` 还原成数字 `7`。JSON 坏到读不出来时，会生成一条无效调用告诉模型重写，不会悄悄当成普通回答。模型自己编了 `<tool_result>` 时，从那里往后的内容全部丢掉，免得假结果混进历史。

**历史始终是标准形状。** 文字协议只在发请求和读响应的时候转换，`agent.history` 里存的永远是标准的 `tool-call` 块和 `tool` 消息。同一台 Agent 中途从纯对话模型换成原生工具模型（或反过来），历史直接接着用。

流式输出时，文字协议的 `<tool_call>` 原文也会出现在 `onLLMEvent` 的 `text-delta` 里，前端想隐藏可以按这个标签过滤。`result.text` 和历史里的文字已经去掉了调用部分。

需要包内没有预设的 Provider 或模型中间件时，直接传 AI SDK 模型实例；实例由调用方创建，`baseURL`、`apiKey`、`protocol` 就不必重复写。下面的进阶用法需要调用方安装对应的 Provider 包：

```js
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import Agent from '@kernel4632/agent-core'

const model = createOpenAICompatible({
    name: 'custom', baseURL: 'https://api.example.com/v1', apiKey: 'sk-xxx',
}).chatModel('model-name')
const agent = Agent.create({ config: { model, provider: { temperature: 0.3 } } })
const answer = await agent.send('你好')
console.log(answer.text)
```

模型实例的额外请求头仍可写在 `provider.headers`；`provider.body`、自定义的 `cache` 对象、以及 `capabilities.toolChoice: false`（它要改写请求体才能生效）都需要本包创建连接，不能用于已创建的模型实例，设置时会明确报错。默认的 `cache: true` 对模型实例会安静跳过——实例的缓存设置由创建它的人负责。

> `provider.toolChoice` 保持 `auto` 时，模型才能在任务做完后正常收尾，`{ reason: 'no-tool' }` 这个结束方式也才有意义。
> 改成 `required` 会强制模型每轮都调工具，而且部分服务（实测 gpt-oss-120b）在模型不想调工具时会直接返回 `tool_use_failed`。

**`callbacks` 回调：**

| 回调 | 触发时机 | 参数 |
|------|----------|------|
| `onStart` | 循环开始 | 无 |
| `onLLMStart` | 每次请求模型前 | `{ messages, tools }` |
| `onLLMFinish` | 模型请求完成 | LLM 返回的完整结果 |
| `onLLMEvent` | 流式事件（每个 token） | AI SDK 原生事件 |
| `onPermission` | 工具执行前 | `{ toolName, input, sessionId, toolCallId, signal }` → 返回 `true/false` |
| `onToolCall` | 工具即将执行 | `{ toolCallId, toolName, input }` |
| `onToolOutput` | 工具有流式输出 | `{ toolName, stream, data, toolCallId, input? }`；`data` 是工具 yield / 打印出来的原值，类型不定 |
| `onToolResult` | 工具执行完成 | `{ toolName, output, ... }` |
| `onStep` | 一轮模型和工具都完成后 | `{ step, result, toolCalls, toolResults }` |
| `onRetry` | 请求失败重试 | `{ attempt, error, delay }`（主请求和压缩请求共用） |
| `onCompact` | 上下文压缩 | `compact-start` / AI SDK 事件 / `compact-finish` |

除了 `onPermission`，所有回调都只是通知：回调自己抛错会被忽略，任务照常进行，工具结果也不会被改写。`onPermission` 的返回值决定放不放行，所以它抛错时这次 `send` 会失败，交给你的 `.catch()`。注意它按"非 `true` 即拒绝"处理：**每个分支都要显式 `return true`**，忘了返回会让那次工具被拒。

#### `agent.send(input)` / `agent.send(options)`

只发送文字或内容块数组时直接传入；要覆盖配置、历史、工具或回调时传对象。如果上一次 `send` 还在运行，本次调用会先自动停止上一次任务，再启动新任务。

```js
await agent.send('继续')

const result = await agent.send({
    input: '帮我写个函数',          // 用户输入（必填）。也可以是内容块数组，见下方"发图片"
    config: { model: '新模型' },    // 可选：覆盖部分配置（会写回 Agent，之后的 send 继续生效）
    history: [],                   // 可选：整份替换历史（也写回 Agent）
    tools: newTools,               // 可选：整份替换工具集（也写回 Agent）
    callbacks: { onLLMEvent: e => {} }, // 可选：合并回调（逐项写回 Agent，最后传的长期生效）
})

// 注意：这四项覆盖都写进 Agent 状态，本次 send 之后一直有效，不是"只作用这一次"。
// 想只影响一次，就在这次 send 里传对值，或之后再传一次恢复。

// result.text → 最后一轮模型生成的文字
// result.steps → 这次 send 一共请求了模型几轮
// result.usage → 整次 send 的用量合计：{ inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens }
//                算钱、看缓存命中直接读这里；cacheReadTokens / inputTokens 就是缓存命中率
// result.reason:
//   'finished'   → 没注册工具，或结构化输出已校验成功：这就是最终回答
//   'no-tool'    → 有工具，但连续 noToolRounds 轮（默认 3）没调用工具才结束
//   'tool-stop'  → 某个工具返回了 stop: true
//   'step-limit' → 达到 maxSteps，当前工具结果已保存，下一次 send 可继续
```

`send` 的出错方式只有一种：返回的 Promise 拒绝。空输入、非法配置、取消、模型报错全都从这里出来，所以只需要写 `.catch()`，不用另外包同步的 `try/catch`。取消造成的拒绝带 `error.kind === 'aborted'`；模型报错的 `error.kind` 见下方。

> 输入是在发请求**之前**就写进 `history` 的，所以一次 `send` 失败后，这条输入已经留在历史里（历史只增不删）。重试前记得先决定要不要把它去掉，否则会叠成连续两条同样的输入。

连续发送时，建议保存并处理旧任务的 Promise，避免出现未处理的中止错误：

```js
const oldTask = agent.send({ input: '执行旧任务' })
const newTask = agent.send({ input: '改执行新任务' }) // 自动停止旧任务

await oldTask.catch(() => {}) // 旧任务可能以 AbortError 结束
const result = await newTask
```

**发图片：** `input` 除了字符串，也可以是 AI SDK 风格的内容块数组。截图、用户在 IM 里发来的图都走这条路。

```js
await agent.send({
    input: [
        { type: 'text', text: '这张截图里哪个按钮是提交？' },
        { type: 'image', image: 'data:image/png;base64,' + png },   // 也可以传 URL 或 Uint8Array
    ],
})
```

能不能看懂取决于模型本身。实测 `kimi-k2.6` 可以，`gpt-oss-120b` 没有视觉能力、会直接报 `content must be a string`——是大声失败，不是静默忽略。

> 直接 `send` 的内容块形状由你保证（工具返回的媒体会在边界自动校验并归一化；用户直接发的内容块不做校验）。图片块用 `{ type: 'image', image: <data URL 或 base64 或 URL 对象> }`，或 AI SDK 当前的 `{ type: 'file', mediaType, data }`。

#### `agent.stop()`

停止正在运行的 Agent。

```js
await agent.stop()   // 等待完全停止后返回 { ok: true }；Agent 空闲时返回 { ok: false }
```

#### 流式与网页实时推送

`send` 内部默认就是流式（`config.stream` 默认 `true`），`await` 拿到的是和流式一样的结果。想实时拿到每一块，用 `onLLMEvent`：模型每吐一段就调用一次，事件是包内 AI SDK 的原生事件。

```js
await agent.send({
    input: '帮我查一下',
    callbacks: {
        onLLMEvent: event => {
            if (event.type === 'text-delta') show(event.text) // 模型新吐的一段文字
        },
        onToolOutput: output => show(output.data),                  // 工具产生的实时输出
    },
})
```

网页要边生成边推给浏览器时，用同样的回调，把内容写进一个标准 `Response` 流：

```js
// Bun.serve 的 fetch 里。开始请求，立刻把响应返回给浏览器，内容随后一块块写上。
app.get('/chat', async request => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
        async start(controller) {
            const send = data => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
            try {
                // send 里的 onLLMEvent 在流式过程中被反复调用，每段文字都及时写出去。
                const result = await agent.send({
                    input: await request.text(),
                    callbacks: {
                        onLLMEvent: event => { if (event.type === 'text-delta') send({ text: event.text }) },
                        onStep: () => send({ status: 'step-done' }),
                    },
                })
                send({ done: true, reason: result.reason })
            } catch (error) {
                send({ error: error.message, kind: error.kind })     // 可传输的错误描述和分类。
            } finally { controller.close() }
        },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' } })
})
```

要取消某次运行，给 `send` 传 `signal`（如 `request.signal`）或调用 `agent.stop()`，两者都能终止。

模型请求失败时抛出的错误带一个稳定的 `kind`：`aborted`（用户取消）、`auth`（密钥或权限，401/403）、`limit`（限流，429）、`timeout`（单笔超时或 408）、`server`（5xx）、`network`（没连上）、`request`（其余 4xx）、`unknown`（服务返回成功状态码，但回答格式对不上，常见于不完全兼容的中转站）。上层靠它决定该换模型、该等一下还是该直接报错，不用去认 AI SDK 的内部错误形状。`kind` 只补充信息；能不能重试由 Retry 的规则统一决定（见上方「重试规则」），默认除取消和上下文超长外都重试，调用方可用 `retry` 过滤。

#### `agent.compact(options?)`

手动压缩当前历史（会先停止正在进行的任务）。默认使用 `Agent.create` 中配置的 `onCompact`、`onRetry`；在本次调用中传入同名回调可以覆盖默认值。

```js
const summary = await agent.compact({
    onCompact: event => console.log(event),
})
// summary 是压缩后的文本，同时会自动追加到 agent.history
```

#### `agent.history`

Agent 当前的完整历史消息数组，可直接读写。

#### `agent.running`

`null` 表示空闲；运行中时是 `{ controller, task }` 对象。

---

### `Agent.tool`

#### `Agent.tool.from(...sources)`

一行拼装工具集合。每个参数可以是目录、内存工具对象、数组、record、已经装好的集合，或它们的 Promise；同名时后面的覆盖前面的。

```js
const tools = await Agent.tool.from(
    './tools',                 // 目录：文件工具跑在子进程里
    mcpClient.tools(),         // 内存工具：MCP / AI SDK 给的工具对象，主进程直接调
    { skill: skillTool },      // record（一个对象，键是工具名）：自定义函数；也可以传数组 [{ name, ... }, ...]
)
const agent = Agent.create({ config, tools })
```

`create` 收已经装好的工具（同步，不扫目录）；`send` 收任意形状，目录会在发送的那一刻现扫。只有一个来源时也可以直接用下面的 `scan` / `adopt`。

#### `Agent.tool.scan(directory)`

扫描目录（含子目录）里所有 `.js` / `.mjs` / `.ts` / `.mts` 文件，把其中形状对得上的注册成工具，其余文件跳过。Bun 直接执行 TypeScript，所以工具可以直接写成 `.ts`；只有类型、没有代码的 `.d.ts` 会被跳过。

```js
Agent.tool.scan('./tools')                                // 路径字符串（相对宿主进程的当前目录）
Agent.tool.scan(new URL('./tools', import.meta.url))      // URL——嵌进别人项目时用这个
Agent.tool.scan(builtinDir, userDir)                      // 多个目录，后面的覆盖前面的同名工具
```

多目录那条顺带给了你一个免费的覆盖机制：内置工具目录在前、用户工具目录在后，用户放一个同名工具就能替换掉内置的，不需要任何注册逻辑。

```js
const tools = await Agent.tool.scan('./tools')
// tools.schema   → 给模型看的工具描述，传给 create/send 的 tools（或 Loop.run 的 tools）
// tools.handlers → 执行器用的处理表，Tool.execute 需要它
```

每次调用都是独立的，多个 Agent 可以各扫描各的目录，互不影响。

#### `Agent.tool.adopt(input)`

把内存里的常规工具对象变成和 `scan` 一样的 `{ schema, handlers }`。内存工具在主进程直接执行，不走子进程。

```js
Agent.tool.adopt([{ name: 'add', description: '加法', inputSchema: {...}, execute: async input => input.a + input.b }]) // 数组
Agent.tool.adopt({ add: { description: '加法', inputSchema: {...}, execute } })  // record：AI SDK / MCP toolset 的形状
Agent.tool.adopt(await mcpClient.tools())                                        // MCP 客户端的工具直接传
```

`inputSchema` 可以是裸 JSON Schema、zod，或 AI SDK 的 `jsonSchema()`。`execute(input, { abortSignal })` 会收到取消信号（也接受别名 `signal`）。

文件工具和内存工具可以合并：`Agent.tool.merge(await Agent.tool.scan('./tools'), Agent.tool.adopt(mcpTools))`，或者直接用 `Agent.tool.from('./tools', mcpTools)`（见上）。

**MCP 工具直接可用，不需要包装**：`@ai-sdk/mcp` 的 `client.tools()` 自带 `execute` 和 `toModelOutput`，核心按 AI SDK 的签名调用它们，文字、图片都会正确交给模型。完整接入例子见前面的[「接入 MCP 和技能」](#接入-mcp-和技能)。

想自己改写某个工具的返回结果时，给它加一个 `toModelOutput`，签名和 AI SDK 一致（拿到的是 `{ output, input }`）：`toModelOutput: ({ output }) => ({ type: 'content', value: output.content })`。

> 从 0.16 升级：`Agent.create({ mcp })`、`agent.mcp`、`Agent.skill` 和 `create({ skills })` 已删除。MCP 改为自己用 `@ai-sdk/mcp` 连接，再把工具传进 `tools`；技能的提示词自己拼进 `config.system`。
>
> 从 0.19 升级：`onPermission` 的 `arguments` 字段改名为 `input`；结束原因多了一个 `'finished'`（没注册工具、或结构化输出已校验成功，原先是 `'no-tool'`）。工具对象的 `execute(input, { abortSignal })`、`toModelOutput({ output, input })` 现在按 AI SDK 签名调用。
>
> 从 0.21 升级：去掉了 `gpt-tokenizer`，上下文 token 改用**自校准估算**（字符数 × 每字符 token 比，比例由真实 `usage` 学到，跟着模型走）；`maxTokens` 默认变为 `128000`，**自动压缩默认开启**（想关掉设 `maxTokens: Infinity`）。产物从 ~3.9 MB 降到 ~1.3 MB。
>
> 从 0.22 升级：内存工具声明的 `timeout` 现在真的生效；新增 `capabilities.usage`（关掉流式请求里的 `include_usage`）；`compactThreshold`、字符串型 `maxTokens` 等非法配置现在会在 `send` 入口报错。
>
> 从 0.23 升级：内存工具（`Agent.tool.adopt`）现在也支持 `async *execute` 流式输出，和文件工具一致；`Tool.from` 接受一组目录（字符串数组）；取消错误统一带 `error.kind === 'aborted'`。

#### `Agent.tool.execute(options)`

直接执行一个工具（通常不需要手动调用，Agent 内部会调用）。

```js
const result = await Agent.tool.execute({
    name: 'add',
    input: { a: 1, b: 2 },
    handlers: tools.handlers,
    signal: abortController.signal,   // 可选：取消信号
    onOutput: output => {},           // 可选：接收工具流式输出（文件工具的 stdout/生成器 yield，内存工具的生成器 yield）
    limit: 32000,                     // 可选：输出字符上限，超出从中间截断；不传则不截断
    concurrency: 8,                   // 可选：同一批（同一个 signal）最多同时跑几个文件工具，超出的排队
})
// result.output → 工具输出块，type 是 'text' | 'json' | 'content' | 'error-text' | 'error-json' | 'execution-denied'
// result 还带：stop:true（工具要求结束循环）/ error（工具失败）/ interrupted:true（被取消）
```

---

### `Agent.llm`

#### 结构化结果

```js
const agent = Agent.create({
    config: {
        baseURL, apiKey, model,
        output: Agent.output.object({                       // 要什么形状的结果，写在配置顶层
            schema: Agent.schema.object({ total: Agent.schema.number() }),
        }),
    },
})
const { output } = await agent.send('计算订单总数')
console.log(output.total)
```

`Agent.output` 是包内 AI SDK 的 Output，`Agent.schema` 是包内 Zod，无需另装一套。数组可用 `Agent.output.array({ element: Agent.schema.string() })`，普通 JSON 可用 `Agent.output.json()`。所选模型服务须支持对应输出格式。

有工具时先完成工具调用，再读取最终对象。工具轮、`tool-stop` 或轮数用尽不会凭空产生 `output`。最终对象校验成功立即结束；格式错误默认也会重试（重新生成不保证还是坏的），想让它立刻失败可用 `retry` 过滤或收紧 `retryMaxElapsed`。手动及自动压缩只生成文本总结，不继承任务的对象格式。流式和非流式都在最终结果上提供 `output`；流中仍会有生成时的文字片段。

直接使用底层 LLM，绕过 Agent 循环。

#### `Agent.llm.chat(options)`

```js
const result = await Agent.llm.chat({
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-xxx',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: '你好' }],
    provider: { temperature: 0.3 },            // 生成参数原样转给 AI SDK
    stream: true,                              // 默认 true
    onLLMEvent: event => console.log(event),   // 流式事件回调
})
// result.text          → 模型回复的文字
// result.toolCalls     → 工具调用列表
// result.usage         → token 用量
// result.finishReason  → 停止原因
```

`Agent.llm.chat` 只负责和模型说话，不处理文字工具协议（`toolMode` 是 Agent 的配置，由主循环负责）。直接调它、又要让纯对话模型用工具时，自己在请求前后各调一次：

```js
const spec = await Agent.textTools.prepare(tools.schema)                       // 把工具表写成说明书
const reply = await Agent.llm.chat({ ...connection, messages: Agent.textTools.wrap(messages, spec) }) // 不带 tools 字段
const result = Agent.textTools.read(reply, spec, { loose: true })             // result.toolCalls 就是读回来的调用
```

---

### `Agent.context`

#### `Agent.context.build(options)`

把历史消息裁剪成模型能用的上下文，并估算 token 数。

```js
const { messages, token } = Agent.context.build({
    history: agent.history,
    system: '你是助手',
    tools: tools.schema,
})
// messages → 可以直接传给 LLM.chat 的消息数组
// token    → 估算的 token 数（不装分词器：字符数 × 每字符 token 比，比例由 Loop 从真实 usage 自校准）
```

裁剪的最小单位是**回合**，不是消息。一个回合 = 模型的一次响应 + 它发起的全部工具调用 + 这些调用的结果，
永远同进同出。所以裁剪结果里不会出现"有调用没结果"或"有结果没调用"的残缺配对——那种序列会被
OpenAI 和 Anthropic 直接 400。

压缩时自动保留：用户最初的 3 个回合（保留原始目标）+ 最新总结 + 总结前最近 3 个回合 + 总结后所有回合。

模型的思考内容（`reasoning`）会留在 `history` 里供上层 UI 渲染，但不会回传给模型：
它是某一次响应的厂商产物，不是持久对话状态，回传还会被一些服务拒绝。

---

### `History`（从 `Agent.history` 获取）

```js
const History = Agent.history   // 从唯一入口拿，打包成单文件之后也一样

// 创建各种类型的历史块
History.user({ content: '你好' })
History.user({ content: [{ type: 'text', text: '这是什么' }, { type: 'image', image: dataUrl }] })  // 带图片
History.assistant({ content: '你好', toolCalls: [{ id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } }] })
History.tool({ toolCallId: 'call-1', toolName: 'add', content: '3' })
History.compact({ content: '之前的对话总结...' })
```

**读历史**——渲染给用户看、数聊了几轮，这两件事的知识本来就在核心里，不用你照着内部结构重写：

```js
History.render(agent.history)
// user: 帮我读一下配置
// assistant: [思考] 我来读 [调用 read {"path":"a.json"}]
// tool: [read 返回] {"port":8080}
// user: 这张图呢 [图片]

History.turns(agent.history)   // 折成回合：[[user], [assistant, tool], [user]]
```

`turns()` 的规则比看上去微妙——**工具结果认的是发起它的 `toolCallId`，不是它在数组里排在谁后面**。从数据库按 id 恢复会话时结果可能排在调用前面，自己推一遍很容易算错。`Context.build()` 裁剪上下文用的就是这同一份实现，所以"什么是一个回合"在整个包里只有一处定义。

想自己排版的，用 `turns()` 拿到回合，再按内容块类型（`text` / `reasoning` / `tool-call` / `tool-result` / `image` / `file`）自己拼。

---

## 上生产前

下面这些旋钮**默认都不限制**，本地玩没问题，生产必须显式设置。每个配一句为什么：

| 旋钮 | 默认 | 为什么生产必须设 |
|------|------|------------------|
| `maxToolOutput` | 不截断 | 工具输出不截断有 31 万 token 风险：一个 1MB 的文本（`cat` 一个日志文件）就够，超过多数模型的整个窗口，还会永久留在历史里，压缩也救不回来。设个字符数，比如 `32000`。 |
| `maxToolConcurrency` | 不限制 | 默认不限文件工具并发：模型偶尔一轮返回几十个工具调用，会瞬间起几十个进程。设个上限，比如 `8`。 |
| `requestTimeout` | 不限制 | 默认不限单笔时长：卡住的请求会一直等下去。设毫秒数，到点中断这一笔。 |
| `retryMaxElapsed` | 不限制 | 默认重试所有错误且无总上限，等于无限重试。生产建议设毫秒数收口，或用 `retry` 过滤掉不该重试的错误（如 `auth`、`request`）。 |
| `maxTokens` | `128000` | 上下文预算，要按你模型的窗口调。比窗口大会撑爆，比需求小会频繁压缩。 |

## 可观测性

每一轮里模型花了多久、工具花了多久、什么时候压缩，用现成的回调就能拼出来。它们只是通知，抛错也不影响任务：

```js
const startedAt = new Map()   // toolCallId → 开始时间

const agent = Agent.create({
    config,
    callbacks: {
        // 一次模型请求的耗时和用量
        onLLMStart: () => { startedAt.set('llm', performance.now()) },
        onLLMFinish: result => {
            console.log('模型耗时', (performance.now() - startedAt.get('llm')).toFixed(0), 'ms', result.usage)
        },
        // 每个工具的耗时和结果
        onToolCall: ({ toolCallId, toolName, input }) => {
            startedAt.set(toolCallId, performance.now())
            console.log('工具开始', toolName, input)
        },
        onToolResult: ({ toolCallId, toolName, output }) => {
            console.log('工具结束', toolName, (performance.now() - startedAt.get(toolCallId)).toFixed(0), 'ms', output)
        },
        // 一轮（模型 + 全部工具）结束
        onStep: ({ step, toolCalls }) => {
            console.log('第', step, '轮结束', toolCalls.length, '个工具')
        },
        // 压缩开始 / 完成
        onCompact: event => console.log('压缩', event.type, event),
    },
})
```

把这些按 `step` 或 `toolCallId` 串起来写进日志或时序库，就是每一轮的完整观测数据。

想直接接 AI SDK 的 OpenTelemetry，把 `experimental_telemetry` 放进 `config.provider` 即可——本包把 `provider` 整份转给模型调用，不截留字段：

```js
config: {
    // ...
    provider: {
        experimental_telemetry: { isEnabled: true, functionId: 'my-agent' },
    },
}
```

## 示例

[`examples/minimal/`](examples/minimal/) 是一个能直接跑起来的最小项目：用本地假模型，不需要任何密钥，注册一个工具跑完一圈，适合拿来当起点。

```bash
bun examples/minimal/main.js
```

[`examples/app/`](examples/app/) 是一个更完整的 chat 服务示例：同样的本地假模型，演示会话管理 / 持久化 / 流式 / 权限 / 观测 / 取消 / 生产设置，适合要写真实应用的人参考。

```bash
bun examples/app/server.js
```

## 长跑压测

`bun scripts/stress.js` 会跑多会话 × 多轮，打印完成情况和内存增量。生产长期运行前，先在你自己的负载上压一遍。

## 运行测试

```bash
bun test
```

测试在 [`tests/`](tests/) 里按 Agent、模型、上下文、工具等模块分文件；模型测试使用本地模拟服务。

查看覆盖率：

```bash
bun test --coverage
```

---

## 打包成单文件

```bash
bun run build
```

只生成 `dist/agent-core.js`：Bun 运行时使用的依赖全部内联并压缩。同时把手写的类型声明 `index.d.ts` 复制成 `dist/agent-core.d.ts`，TypeScript 用户导入时有参数补全和类型检查。构建脚本在没有 `node_modules` 的临时目录中导入产物，实际运行一次工具和模型模拟请求，成功后才替换 `dist/agent-core.js`。发布包只包含 `dist/agent-core.js`、`dist/agent-core.d.ts`、`README.md`、`LICENSE` 和 `package.json`；`npm pack` / `npm publish` 前会自动构建。产物顶部写有版本号和提交号，压缩不是加密。

```js
import Agent from './agent-core.js'

// 工具目录用 URL 指，永远相对你自己这份代码，不受宿主进程当前目录影响
const tools = await Agent.tool.scan(new URL('./tools', import.meta.url))
const agent = Agent.create({ config: { /* ... */ }, tools })
```

`default` 导出就是全部入口，嵌入方需要的东西都挂在上面：

| | |
|---|---|
| `Agent.version` | 包版本，排查问题时报得出来 |
| `Agent.create(...)` | 创建 Agent 实例 |
| `Agent.tool` | `.from()` / `.scan()` / `.adopt()` / `.execute()` / `.merge()` |
| `Agent.history` | `.user()` / `.assistant()` / `.tool()` / `.compact()` 造消息块；`.turns()` / `.render()` 读历史 |
| `Agent.context` | `.build()` |
| `Agent.compact` | `.run()` |
| `Agent.llm` | `.chat()` |
| `Agent.textTools` | 文字工具协议：`.prepare()` / `.wrap()` / `.read()`，直接调 `llm.chat` 时用 |
| `Agent.output` / `Agent.schema` | 结构化输出的 Output 与 Zod，包内同一份，无需另装 |

`Agent.history` 和 `Agent.textTools` 还导出一些底层方法（`stored` / `model` / `parts` / `answeredCalls`，以及文字协议的 `parse` / `downgrade` / `refused` / `remember` / `remembered`），完整列表见 `index.d.ts`。

`Agent.history` 是嵌入时最常用的那个：把 IM 消息转成 user 块、往历史里塞一条系统通知、从数据库恢复会话，都要靠它造出格式正确的消息。

**工具进程需要一个 bun 运行时。** 普通 `bun run` 时用的就是宿主自己（`process.execPath`，不依赖 PATH）；宿主被 `bun build --compile` 成单可执行文件时，会退回 PATH 上的 `bun`——这种分发方式需要目标机器装了 bun。

工具目录不会被打包——它本来就该是运行时扫描的，放文件即加功能这件事在打包后照样成立。

工具进程那一半（`features/tool-process.js`）在打包时会被当成文本内联进单文件，运行时通过 `bun -` 从 stdin 喂给一个新的子进程，
所以产物挪到任何目录都能正常执行工具，也不会往磁盘上写临时文件。
这也是 `tool-process.js` 里不能出现任何 `import` 的原因：它以匿名程序的身份运行，相对路径和裸包名会按进程当前目录解析，必然出错。
（用 stdin 而不是 `bun -e`：后者在 8KB 到 32KB 之间就会 `ENAMETOOLONG`，而工具进程源码已经接近这个量级。）

---

## 这个包不做什么

一个包被失望，通常不是因为它功能少，是因为它没说清自己不管什么。下面是明确的边界，请先确认这些是你想要的，再决定用它。

**不替你保存会话。** `history` 就是一个普通数组，一直放在内存里。进程一退就没了。要让它跨重启、跨设备，由你把 `history` 存进数据库、下次再传回来——怎么存、存多久、怎么按用户隔离，属于你的应用层。核心包不做这件事，也不猜测你用什么存储。

**不算钱。** 返回的 `usage` 是原始 token 数，不乘单价、不累加账单、不按模型区分价格。价格表会变，缓存命中怎么计价各家不同，这些属于上层。

**不做用户和权限系统。** 它只有一个 `onPermission` 回调，在工具执行前问一句"放不放行"。谁是用户、谁登录了、谁能用哪个工具，由你的应用判断后通过这个回调告诉它。

**不隔离多租户。** 一台 Agent 是一个独立对象，`history`、`config`、`running` 都在自己的实例里，实例之间互不影响。但"张三的对话不能跑到李四那里"要靠你给每个用户各自创建 Agent、各自保管 history 来实现，核心包不提供账号、鉴权、数据隔离。

**不管并发排队和限流。** 同一台 Agent 上后一次 `send` 会停掉前一次（这是有意设计的"最新指令优先"）。要让多个用户同时用，就为每个会话建一台 Agent；要限制总并发、总费用，由你的应用做。核心包没有全局任务队列。

**不管 MCP 连接和技能。** 核心只接收通用工具对象。MCP 服务的连接、开关和关闭由你的应用管理，再用 `Agent.tool.adopt` 把工具交进来；技能提示词自己拼进 `system`。

**不做工具的安全检查。** 工具子进程和 Agent 拥有完全相同的权限：读写任意文件、执行任意命令、联网、读到父进程的全部环境变量。这是有意的——电脑任务 agent 的工具本来就得能干这些。**沙箱、白名单、危险命令拦截属于你的应用层**，核心包只提供 `onPermission` 这一个挂钩点。

**不保证所有模型/中转站的兼容性。** 它针对四种协议做了适配，也在真实网关上验证过，但中转站千奇百怪：有的返回的状态码和实际结果不符，有的字段缺失。遇到不兼容时，`error.kind` 会告诉你大概是哪一类问题，但没法替那个服务端修好它。

**不保证长跑和多会话并发下的表现。** 这两项只在小规模下验证过。要在生产环境长期运行，请先按你自己的负载压测。

**没有 GUI、没有服务端、没有命令行工具。** 它只是一个库，被别的程序 `import` 使用。开箱即用的聊天应用不在它的范围内。

---

## 常见问题

**Q：支持 Node.js 吗？**

不支持，而且这是刻意的。工具进程用 [`Bun.spawn` + IPC](features/tool-process.js)，扫描用 [`Bun.Glob`](features/tool.js)，打包靠 `import ... with { type: 'text' }`，都只有 Bun 有。

---

**Q：支持哪些模型提供商？**

通过 `config.protocol` 控制：

| protocol 值 | 适用场景 |
|-------------|----------|
| `chat`（默认） | OpenAI 以及任何兼容 OpenAI Chat 接口的中转站 |
| `responses` | OpenAI Responses API |
| `anthropic` | Anthropic 官方接口 |
| `gemini` | Google Gemini 接口 |

---

**Q：上下文太长会怎样？**

上下文超过 `config.maxTokens` 的 `compactThreshold`（默认 0.8，即 80%）时，Loop 会自动调用 Compact 把历史压缩成一段总结，然后继续运行。**默认就开着**：`maxTokens` 默认 `128000`，不配置也会在接近上限时自动压缩，避免把上下文撑爆。你的模型窗口比这小就把它调小；想彻底关掉设 `maxTokens: Infinity`。

**上下文 token 怎么估**：不装分词器，用"字符数 × 每字符多少 token"。这个比例是**会自校准**的——每轮模型都会回 `usage.inputTokens`（这次请求真实的输入 token 数），拿它反推这个模型真实的"每字符 token 比"记下来给下一轮。换模型（`config.compact` 的压缩模型、`send` 时覆盖 `model`、换 provider）就换一条记录，越用越准，也不怕分词器对不上模型。

**压缩只往 `agent.history` 里追加一条总结，永远不删任何东西。** `history` 是唯一权威数据来源，该保留多少由持有它的你来决定——压缩控制的是"这一轮发给模型的内容有多大"，不是"历史能留多少"。

**压缩可以另配一套模型。** 总结不需要主模型那么聪明，用便宜的小模型就够，写在 `config.compact` 里：

```js
config: {
    baseURL: 'https://api.example.com/v1', apiKey: 'sk-xxx', model: '主模型',
    compact: { model: '便宜的小模型' },   // 也能一起换 baseURL / apiKey / provider
}
```

不写 `compact` 就和主模型共用。自动压缩和手动 `agent.compact()` 用的都是这一套。

> 用更小的小模型做压缩时注意：那笔压缩请求的**大小是由主模型的 `maxTokens` 决定的**，跟压缩模型自己的窗口无关。如果压缩模型的窗口比主模型预算小，压缩请求会先在小模型这边撑爆。让压缩模型的窗口 ≥ 主模型预算，或把 `maxTokens` 调小。

**最新的那条总结会折进 `system`，而不是当成一条用户消息塞进对话里**，并且带一句"这是你自己之前做过的工作，数据已由工具确认"。裸的 `role:'user'` 总结会被模型读成"用户塞给我一张表"，于是它从头重做整个任务——真实端点实测 `gpt-oss-120b` 改之前 1/6 能正确续跑，改之后 6/6。

保留多少旧内容是**按预算**算的，不是按条数：最初目标最多占 20%、总结前的现场最多占 30%，总结之后的新回合不受限。只按条数留的话，用户第一条消息粘一大段日志就能让压缩永远收敛不了（实测 120/120 轮压完仍超阈值）。放不下的最初目标不会丢——总结本身就被要求保留用户的原始目标，而总结在 `system` 里，永远不会被裁掉。

每轮最多压一次。压完还超限就照常发出去，由模型服务判断收不收；下一轮还超自然会再压。**不会**为了压到达标而连续调用模型——那样一轮能烧掉上千次请求。

---

**Q：工具返回一个巨大的结果会怎样？**

默认不截断（`maxToolOutput` 默认 `undefined`）。设置 `config.maxToolOutput`（字符数）后，超出的部分会从中间截断，头尾都保留，并插入一段明确的提示告诉模型"输出过长、请缩小范围或分页重新获取"。

截断**只作用于文字**。多模态输出块里的图片、文件一个字节都不动——截一刀就彻底废了，截图工具的返回值本来就大。

建议主动设置它（比如 `maxToolOutput: 32000`）：实测一个返回 1MB 文本的工具（`cat` 一个日志文件就够了）= **31 万 token**，超过大多数模型的整个上下文窗口，而且它会永久留在历史里——连压缩都救不回来，因为压缩本身要把这坨东西发给模型去总结。

---

**Q：工具卡住不返回会怎样？**

默认会一直等——因为**阻塞型工具是被支持的正常用法**：等 IM 消息、盯文件变化、守着一个长任务，这些工具就是要长期不返回。有全局超时反而会把它们全废掉。

需要超时保护的工具自己在工具文件里声明：

```js
export default {
    name: 'fetch_page',
    description: '抓一个网页',
    timeout: 30000,        // 毫秒。超时后工具进程被直接杀掉，模型收到一条超时结果
    inputSchema: { /* ... */ },
    async execute(input) { /* ... */ },
}
```

`agent.stop()` 任何时候都能立刻掐断，不管工具声没声明超时。

---

**Q：工具执行失败会让 Agent 崩溃吗？**

不会。工具失败会被捕获，错误信息会作为工具结果告诉模型，模型可以自行决定是否重试或换一种方式。

这条覆盖得相当彻底：工具自己抛错、工具文件语法错误、工具返回了没法序列化的值（循环引用、函数、类实例）、
`toModelOutput` 自己抛错、甚至工具调 `process.exit` 把整个工具进程干掉——
全都会变成一条模型能读的工具结果，而不是让这次调用永远挂着。

---

**Q：多个工具是串行还是并行执行的？**

并行。模型在一轮里要求调用多个工具时，所有工具同时开跑，结果按原顺序收集后一起写回历史。

同一个 Agent 内，**文件工具**同时最多跑 `config.maxToolConcurrency` 个（默认不限制，一个工具独占一个工具进程），超出的排队。模型偶尔会一轮返回几十个工具调用，建议设一个上限（比如 8）避免瞬间起几十个进程。不同 Agent 各自计算，互不影响。**内存工具（`Agent.tool.adopt` / MCP）在主进程直接跑，不受这个上限约束**——要限它们得在自己的 `execute` 里做。

注意阻塞型工具会**长期占着名额**：上限设成 8、又有 8 个会话各挂一个 `wait_for_message`，第 9 个会话的任何工具都排不进来。多会话的 bot 要按会话数把这个值调大。

---

**Q：怎么让 Agent 在任务完成时自动停止？**

有两种方式：

1. 写一个 `finish` 工具，让它 `return { stop: true }`，并在系统提示词里告诉模型"完成任务时调用 finish 工具"。
2. 不写 finish 工具，依赖默认行为：有工具时模型连续 `noToolRounds` 轮（默认 3，最后一轮请求前会插一次提醒）不调用任何工具，Loop 自动返回 `{ reason: 'no-tool' }`。想让模型一不调工具就结束，设 `noToolRounds: 1`。

---

**Q：怎么中途停止 Agent？**

```js
const runPromise = agent.send({ input: '...' })

// 3 秒后强制停止
setTimeout(() => agent.stop(), 3000)

await runPromise.catch(() => {})    // stop() 会让 send() 以 AbortError 结束
```

或者在 `onPermission` 回调里返回 `false` 拒绝某次工具调用，但不会停止整个循环。
