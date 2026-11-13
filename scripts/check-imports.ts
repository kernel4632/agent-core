/*
导入关系检查：扫描 src/ 下全部 .ts 文件的相对导入（含 import type），验证 issue #30 的硬规则。

运行：bun scripts/check-imports.ts（通过时退出码 0，并打印导入表；违规时逐条列出并以 1 退出）。

规则：
1. 没有循环导入（只算值导入；import type 在运行时被擦除，但 types.ts 本身不允许导入任何文件）；
2. 跨目录的导入只能指向更低的层：agent → loop → { context, model, tools } → history → utils → types；
   同一层的不同能力模块（context / model / tools）之间不允许互相导入；
3. 同目录（含子目录 text-tools 属于 model 层）内的导入允许，由规则 1 保证不成环。
*/

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'

// 项目根与 src 目录（本脚本在 scripts/ 下）。
const root = resolve(import.meta.dir, '..')
const src = join(root, 'src')

// 层级：数字越大越高；只允许从高层导入低层。能力模块共享第 2 层。
const LAYER: Record<string, number> = { agent: 4, loop: 3, context: 2, model: 2, tools: 2, history: 1, utils: 0, types: -1 }

// 文件属于哪个模块：src 下第一级目录名，或根级文件名（去掉 .ts）。
const moduleOf = (file: string) => relative(src, file).split('/')[0]!.replace(/\.ts$/, '')

// 递归列出 src 下的全部 .ts 文件。
const list = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? list(path) : path.endsWith('.ts') ? [path] : []
})

// 抽出一个文件的相对导入：[目标绝对路径, 是否仅类型]。
const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^import\s+(type\s+)?[^'"]*from\s+'(\.[^']+)'/gm)]
    .map(match => ({ to: resolve(dirname(file), match[2]!), typeOnly: Boolean(match[1]) }))

const files = list(src)
const graph = new Map(files.map(file => [file, importsOf(file)]))
const problems: string[] = []

// 规则 2：跨模块必须向下；types 不导入任何东西。
for (const [from, edges] of graph) for (const { to } of edges) {
    const a = moduleOf(from), b = moduleOf(to)
    if (a === 'types') problems.push(`types.ts 不能导入任何文件：${relative(src, to)}`)
    if (a !== b && !(LAYER[a]! > LAYER[b]!)) problems.push(`越级 / 同级导入：${relative(src, from)} → ${relative(src, to)}`)
}

// 规则 1：值导入不成环（深度优先，记录路径以便报告）。
const state = new Map<string, 'visiting' | 'done'>()
const visit = (file: string, path: string[]) => {
    if (state.get(file) === 'done') return
    if (state.get(file) === 'visiting') { problems.push(`循环导入：${[...path, file].map(p => relative(src, p)).join(' → ')}`); return }
    state.set(file, 'visiting')
    for (const { to, typeOnly } of graph.get(file) ?? []) if (!typeOnly) visit(to, [...path, file])
    state.set(file, 'done')
}
for (const file of files) visit(file, [])

// 打印导入表（不含 types.ts），方便和 issue 里的表对照。
for (const [from, edges] of graph) {
    const values = edges.filter(edge => !edge.typeOnly).map(edge => relative(src, edge.to))
    console.log(`${relative(src, from).padEnd(28)} ${values.join(', ') || '—'}`)
}
if (problems.length) { console.error('\n' + problems.join('\n')); process.exit(1) }
console.log(`\n通过：${files.length} 个文件，没有循环导入、越级或同级能力模块互相导入。`)
