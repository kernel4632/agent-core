/*
打包发布产物：单文件 dist/agent-core.js（依赖全部打进去）+ dist/types/ 下的类型声明。
调用：bun run build。只有在脱离本项目 node_modules 的临时目录里自检通过，产物才会写进 dist/。

三步：
1. 先把工具子进程入口 src/tools/child.ts（连同它导入的 shape.ts）单独打成一段源码文本；
2. 再打包 index.ts，用 define 把这段源码作为 __AGENT_CORE_CHILD__ 常量内联进去——
   tools/spawn 见到这个常量就以 `<execPath> -` 启动子进程、从 stdin 喂源码，不依赖任何包内文件路径（issue #30 第 16 条 A）；
3. tsc 按 tsconfig.build.json 生成 .d.ts，并把声明里的相对导入 `./x.ts` 改写成 `./x.js`，
   让没开 allowImportingTsExtensions 的使用方也能解析（TS 会把 .js 映射到同名 .d.ts）。

自检：在临时目录导入产物，用一个假的 OpenAI 兼容服务跑一次"模型调工具 → 子进程执行 → 再回答"，
确认内联的子进程入口真的能跑。
*/

import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { version } from '../package.json'

const root = fileURLToPath(new URL('../', import.meta.url))   // 项目根目录，按本文件位置算，换目录启动也不跑偏。
const revision = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: root }).stdout.toString().trim() || 'unknown' // 产物里记下提交号，排查时能对上。
// 两次打包共用的选项：只在 Bun 上跑、ESM、依赖一起打进去、压缩、不要 sourcemap。
const common = { target: 'bun', format: 'esm', packages: 'bundle', minify: true, sourcemap: 'none' } as const

// --- 1. 子进程入口单独打成文本 ---
const child = await Bun.build({ ...common, entrypoints: [join(root, 'src', 'tools', 'child.ts')] })
if (!child.success || child.outputs.length !== 1) throw new Error(`子进程入口打包失败：${child.logs.join('\n')}`)
const childSource = await child.outputs[0]!.text()

// --- 2. 主产物，内联子进程源码 ---
const main = await Bun.build({ ...common, entrypoints: [join(root, 'index.ts')], define: { __AGENT_CORE_CHILD__: JSON.stringify(childSource) } })
if (!main.success || main.outputs.length !== 1) throw new Error(`打包失败：${main.logs.join('\n')}`)
const bundle = `// @kernel4632/agent-core ${version} (${revision})\n${await main.outputs[0]!.text()}`

// --- 3. 类型声明 ---
const types = join(root, 'dist', 'types')
await rm(types, { recursive: true, force: true })
const tsc = Bun.spawnSync([process.execPath, 'x', 'tsc', '-p', join(root, 'tsconfig.build.json')], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BUN_BE_BUN: '1' } })
if (tsc.exitCode !== 0) throw new Error(`生成类型声明失败：${tsc.stdout}${tsc.stderr}`)
// 递归改写声明里的相对导入扩展名。
const rewrite = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await rewrite(path)
        else if (entry.name.endsWith('.d.ts')) await writeFile(path, (await readFile(path, 'utf8')).replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2'))
    }
}
await rewrite(types)

// --- 自检：临时目录里没有 node_modules，产物必须能独立跑通"调工具 → 子进程 → 再回答" ---
const temp = await mkdtemp(join(tmpdir(), 'agent-core-build-'))
let step = 0
const server = Bun.serve({
    port: 0,
    fetch: () => {
        step += 1                                                     // 第一次要求调工具，第二次给最终回答。
        const message = step === 1
            ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"value":"build"}' } }] }
            : { role: 'assistant', content: 'ok' }
        return Response.json({ choices: [{ index: 0, message, finish_reason: step === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } })
    },
})
try {
    const filename = join(temp, 'agent-core.js')
    await writeFile(filename, bundle)
    await writeFile(join(temp, 'echo.js'), "export default { name: 'echo', description: 'echo', parameters: { type: 'object', properties: { value: { type: 'string' } } }, run: ({ value }) => `done:${value}` }\n")
    const script = `
        import { Agent } from ${JSON.stringify(pathToFileURL(filename).href)}
        const agent = Agent.create({ baseURL: 'http://127.0.0.1:${server.port}/v1', model: 'test', stream: false, tools: [${JSON.stringify(join(temp, 'echo.js'))}], noToolRounds: 1 })
        const answer = await agent.send('hi')
        const result = agent.history.find(message => message.role === 'tool')?.content[0]?.output?.value
        if (result !== 'done:build') throw new Error('工具子进程失败：' + JSON.stringify(agent.history))
        if (answer.text !== 'ok') throw new Error('模型请求失败')
    `
    const run = Bun.spawn([process.execPath, '-e', script], { cwd: temp, stdout: 'pipe', stderr: 'pipe' })
    const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`独立产物自检失败：${stderr}`)

    await mkdir(join(root, 'dist'), { recursive: true })
    await cp(filename, join(root, 'dist', 'agent-core.js'))          // 自检通过才替换发布产物；失败时保留上一次可用的文件。
    await rm(join(root, 'dist', 'agent-core.d.ts'), { force: true })  // 旧版手写声明已被 dist/types 取代，别留着误导。
    console.log(`已构建 dist/agent-core.js (${(Bun.file(join(root, 'dist', 'agent-core.js')).size / 1048576).toFixed(2)} MB, ${revision}) 和 dist/types/`)
} finally {
    server.stop(true)
    await rm(temp, { recursive: true, force: true })
}
