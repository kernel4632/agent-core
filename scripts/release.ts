/*
一条命令发版：bun run release <major|minor|patch>

    bun run release patch    只修了问题、改文档
    bun run release minor    加了新能力
    bun run release major    不兼容的改动

它做的事：
  1. 检查工作区干净、在 main 分支上
  2. 本地先跑一遍测试（不过就停，别把坏版本推上去）
  3. 升版本号（就是 bun run bump）
  4. 提交「release: vX.Y.Z」，打标签 vX.Y.Z，推送代码和标签

推送标签之后，GitHub Actions（.github/workflows/release.yml）自动：
  测试 → 构建 → 打包 → 建 Release，上传 agent-core.tgz（latest 链接用）和带版本号的包。

所以本机只需要能 git push，不需要登录 gh，也不用手动传文件。
发布进度在 https://github.com/kernel4632/agent-core/actions 看。
*/

import { fileURLToPath } from 'node:url'
import { repository } from '../package.json'

const root = fileURLToPath(new URL('../', import.meta.url)) // 必须是路径字符串：Windows 上传 URL 对象给 cwd，spawn 会找不到 git。
const slug = new URL(repository.url.replace(/^git\+/, '')).pathname.replace(/^\/|\.git$/g, '')

const run = (command: string, args: string[]): string => {
    const result = Bun.spawnSync([command, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    const out = result.stdout.toString().trim()
    if (result.exitCode !== 0) throw new Error(`${command} ${args.join(' ')} 失败：\n${result.stderr.toString().trim() || out}`)
    return out
}

const part = process.argv[2]
if (!part || !['major', 'minor', 'patch'].includes(part)) throw new Error('用法：bun run release <major|minor|patch>')

// --- 1. 发布的内容必须是 main 上一个干净的提交 ---
const dirty = run('git', ['status', '--porcelain'])
if (dirty) throw new Error(`工作区还有没提交的改动，先提交或撤销：\n${dirty}`)
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') throw new Error(`只能在 main 分支发版，当前在 ${branch}`)

// --- 2. 本地先测一遍：不过就别推，省得 GitHub 那边白跑一趟 ---
console.log('本地测试…')
run('bun', ['test'])

// --- 3. 升版本号 ---
const bumped = run('bun', ['scripts/bump.ts', part])
const next = bumped.split('→').pop()!.trim()
const tag = `v${next}`
console.log(bumped)

// --- 4. 提交、打标签、推送 ---
run('git', ['add', 'package.json'])
run('git', ['commit', '-m', `release: ${tag}`])
run('git', ['tag', tag])
run('git', ['push'])
run('git', ['push', 'origin', tag])

console.log(`\n已推送 ${tag}，GitHub 正在自动构建发布：https://github.com/${slug}/actions`)
console.log(`发好后装最新版：bun add https://github.com/${slug}/releases/latest/download/agent-core.tgz`)
