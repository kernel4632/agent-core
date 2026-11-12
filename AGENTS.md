# agent-core 项目规则

## 每改完一点就提交推送，不用等确认

每完成一小步就提交并推送，不要攒着一批改动等用户确认。
这样做是为了出错时能精确回退到上一个可用的点。

这里的「一小步」指一次能说清楚的改动：修一个问题、加一项能力、一次重构。
不要把好几件不相关的事混在一个提交里。

## 推送前必须改版本号

每次准备 `git push` 之前，先把 `package.json` 里的 `version` 改掉，再提交这次改动。
版本号只写在 `package.json` 一处，`scripts/build.js` 打包时会自动读进产物，不需要改别的地方。

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

## 验证命令

改完代码必须跑这两条，都通过才算完成：

```bash
bun test
bun run build
```

推到 main 之后，GitHub Actions 也会自动再跑一遍测试和构建（`.github/workflows/ci.yml`）。

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
