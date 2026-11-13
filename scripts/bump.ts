/*
升版本号：bun run bump <major|minor|patch|X.Y.Z>

版本号只写在 package.json 一处，这里改完就是唯一事实来源。

    bun run bump patch    0.11.2 → 0.11.3    只修了问题、改文档
    bun run bump minor    0.11.2 → 0.12.0    加了新能力
    bun run bump major    0.11.2 → 1.0.0     不兼容的改动（第一次正式发布也用这个）

升完会打印新版本号，接着按平时的习惯提交推送即可；要发版就跑 `bun run release`。
*/

import { version } from '../package.json'

const root = new URL('../', import.meta.url) // 只是拼文件路径，URL 能用；要交给系统的路径才需要转成字符串。

const part = process.argv[2]
const [major, minor, patch] = version.split('.').map(Number)

let next
if (/^\d+\.\d+\.\d+$/.test(part ?? '')) next = part // 也允许直接写一个完整版本号。
else if (part === 'major') next = `${major + 1}.0.0`
else if (part === 'minor') next = `${major}.${minor + 1}.0`
else if (part === 'patch') next = `${major}.${minor}.${patch + 1}`
else throw new Error(`用法：bun run bump <major|minor|patch|X.Y.Z>，当前 ${version}`)

// 只替换 version 这一个字段的文本，其余格式原样保留——package.json 的排版不该被脚本重写。
// 文件开头可能有 BOM（本机编辑器加过）。读字节才能看出来：TextDecoder 会把它吃掉。
// 写入时按原样带回去，免得升个版本就多出一处无关改动。
const file = new URL('package.json', root)
const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
const bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? '\uFEFF' : ''
const body = new TextDecoder().decode(bytes).replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`)
await Bun.write(file, bom + body)

console.log(`${version} → ${next}`)
