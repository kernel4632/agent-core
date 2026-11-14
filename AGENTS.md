# agent-core 项目规则

## 每改完一点就提交推送，不用等确认

每完成一小步就提交并推送，不要攒着一批改动等用户确认。
这样做是为了出错时能精确回退到上一个可用的点。

这里的「一小步」指一次能说清楚的改动：修一个问题、加一项能力、一次重构。
不要把好几件不相关的事混在一个提交里。

## 推送前必须改版本号

每次准备 `git push` 之前，先把 `package.json` 里的 `version` 改掉，再提交这次改动。
版本号只写在 `package.json` 一处，`scripts/build.ts` 打包时会自动读进产物，不需要改别的地方。

改哪一位：

| 这次改了什么 | 改哪一位 | 例子 |
|--------------|----------|------|
| 加了新能力 | 第二位 | `0.2.0` → `0.3.0` |
| 只修了问题和文档 | 第三位 | `0.2.0` → `0.2.1` |

推送顺序固定为：改版本号 → 跑测试 → 提交 → 推送。

需要用命令改的话：`bun run bump patch`（或 `minor` / `major`），它只改 version 一处。

## 1.x 之前不保留兼容

在发布 1.x 正式版之前，所有改动都**只保留最新的业务实现**：

- 被替代的 API、配置字段、分支直接删掉；不写兼容层，不留 deprecated 别名，不为了旧调用方维持两套行为。
- 调用方（包括下游项目）跟着改；破坏性改动同样按 minor 升版本号（`0.x` 的惯例）。
- 等 1.0 再冻结接口，那时候才需要考虑兼容。

判断标准很简单：**代码里只应该存在一种正确写法**。看到"为了兼容旧版"的分支，就说明该删了。

## 代码结构规则（issue #30）

- **TypeScript，运行在 Bun 上**（engines `bun >= 1.4.4`）。源码在 `src/`，包入口是根目录 `index.ts`，脚本在 `scripts/*.ts`。
- **Agent 是唯一的状态持有者。** 公开字段 `config / history / tools / mcp / contextRatio / ratios / id`，私有 `#internal`（子进程、工具缓存、MCP 连接、取消器、警告去重）。
  **模块里不允许有任何可变的顶层状态**，需要状态就放进 `#internal`、作为参数往下传。
- **loop 是 history 唯一的写入者**；history 只增不删（压缩只追加 `role: 'compact'`）。
- **导入只往下指：** `agent > loop > {context, model, tools} > history > utils > types`。同层能力模块（context / model / tools）互不导入，
  不允许循环导入。`bun run check` 里的 `scripts/check-imports.ts` 负责检查。
- **工具只认文件路径。** 插件、技能、渲染、开关都是宿主的概念，不进核心。工具子进程一律用 `process.execPath` 启动，不写死 `bun`。
- **默认值在读取处套用**，不在构造时写回 config。
- **宿主改状态、下一轮生效。** 开关类能力（`media`、`reasoning`、`mcp[].enabled`、`tools` 路径）都做成宿主可改的状态，每轮现读；
  需要"立即"语义的才加方法（`stop()`、`closeMcp()`），方法也要返回能确认结果的值。
- **一个 Agent 实例就是一段对话。** 核心里没有"会话 / session"概念，`id` 只给宿主区分实例用，核心不读它；多段对话就建多个实例。
- **宿主回调一律经 `utils/errors.tell` 调用**：同步抛错和被拒绝的 Promise 都吞掉（Bun 遇到未处理的拒绝会退出进程）；
  需要宿主先做完的（`onToolCall`、`onStep`）就 `await tell(...)`，高频的（`onChunk`、`onToolOutput`）用 `void tell(...)`。
- **history 永远完整、发不出去的东西在 build 里处理。** 没开的媒体换占位文字、坏消息跳过并警告，不报错、不改 history
  （用户随时可能换模型，原件要留着）。
- **外部能力不拖住对话。** MCP 在后台连接、轮次最多等一小会儿；连不上只警告一次，不自动重连，重试交给宿主切开关。
- **不要把函数拆散。** 只有真的被多处复用时才抽辅助函数；一个文件约 100–200 行，注释（中文）和代码差不多一样多。
  超过 200 行要有理由；自然很小的文件可以少于 100 行。

## 验证命令

改完代码必须跑这三条，都通过才算完成：

```bash
bun run check     # tsc --noEmit + 导入方向检查
bun test          # 用 ai/test 的 mock 模型，不联网
bun run build     # 打包 + 临时目录自检 + 生成 dist/types
```

推到 main 之后，GitHub Actions 也会自动再跑一遍检查、测试和构建（`.github/workflows/ci.yml`）。

## 发布新版

一条命令搞定，自动测 → 升版本号 → 提交 → 打标签 → 推送：

```bash
bun run release patch     # 或 minor / major
```

推送标签后，GitHub Actions（`.github/workflows/release.yml`）自动构建、打包、建 Release、上传附件，
并**用 Trusted Publishing（OIDC）自动发布到 npm**——不需要任何 npm token，也不需要验证码。
本机不需要登录 gh 和 npm，进度在 https://github.com/kernel4632/agent-core/actions 看。

安装链接固定用 `releases/latest/download/agent-core.tgz`，所以**发新版不需要改 README**。
带版本号的包 `kernel4632-agent-core-X.Y.Z.tgz` 也会一起传上去，需要锁版本时用它。

依赖的新版本由 Dependabot 每周开 PR（`.github/dependabot.yml`），CI 绿了合并即可。

npm 发布走 Trusted Publishing，配置是**一次性**的：在 npmjs.com 的包设置里把仓库
`kernel4632/agent-core` 和工作流 `release.yml` 设为可信发布者（已配好）。之后每次推标签都会
自动发到 npm，并带上 provenance 来源证明。`bun run publish:npm` 只在包**第一次**还没上 npm 时
手动用一次；日常发版不需要它。（本机 npm 需 ≥ 11.21、Node ≥ 22.14 才能用 `npm trust` 配置可信发布者。）
