/*
load：每一轮请求前，把 agent.tools 里的路径变成这一轮可用的工具元数据表。

调用示例（在 loop/run 每轮开头）：
    const metas = await load(state.tools, state.internal, callbacks.onWarning)

为什么每轮都调：agent.tools 是宿主随时增删的路径数组（关掉插件就删它的路径），下一次模型请求必须立即生效。
为什么不贵：元数据按"路径 + 修改时间"缓存在 Agent 实例的 internal.toolCache 里，文件没变就复用，
只有新增或改过的文件才起子进程读；目录每轮重新列一次（只是 readdir，很便宜）。

规则（issue #30 第 18 条、Q2、Q8）：
- 路径可以是文件或目录；目录展开成其中的 .ts / .js / .mjs 文件（不递归），按文件名排序；
- 每个需要读的文件一个子进程，全部并行（tools/spawn，mode 'meta'），单个文件约 3 秒超时；
- 某个文件报错、契约不符、顶层死循环（超时）时，跳过它并通过 onWarning 警告宿主，不让整个 Agent 失败；
  同一个坏文件（同一 mtime）只警告一次、之后也不再重读（记在 internal.warned），否则顶层死循环的文件每轮都要白等 3 秒；
- 被 stop() 杀掉的读取不算坏文件：不警告、不记录，下一轮照常读；
- 两个文件导出同名工具时，后出现的跳过并警告；
- 缓存里有、但这一轮路径列表里已经没有的条目删掉，避免缓存无限增长。
导入：同目录 spawn。
*/

import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Internal, ToolMeta } from '../types.ts'
import { spawn } from './spawn.ts'

// 读取单个工具文件元数据的超时：顶层死循环的文件 3 秒后被杀掉并跳过。
export const LOAD_TIMEOUT = 3000

/*
load：按文件头的规则返回这一轮的工具元数据，顺序与 paths（及目录展开后）的顺序一致。
路径不存在时同样只警告、跳过。只修改 internal.toolCache / internal.warned，并通过 internal.procs 登记子进程，
这样 stop() 也能杀掉正在读元数据的子进程。
*/
export async function load(
    paths: string[],
    internal: Pick<Internal, 'toolCache' | 'warned' | 'procs'>,
    onWarning?: (warning: { path?: string; message: string }) => void,
): Promise<ToolMeta[]> {
    const warn = (path: string | undefined, message: string) => { try { onWarning?.({ path, message }) } catch { /* 宿主回调出错不影响加载 */ } }
    // --- 展开路径：目录列一次（不递归），文件原样；相对路径按当前工作目录解析 ---
    const files: { path: string; mtime: number }[] = []
    for (const raw of paths) {
        const path = resolve(String(raw))
        let stat
        try { stat = statSync(path) } catch {
            if (!internal.warned.has(`missing:${path}`)) { internal.warned.add(`missing:${path}`); warn(path, `工具路径不存在：${path}`) }
            continue
        }
        const entries = stat.isDirectory()
            ? readdirSync(path).filter(name => /\.(ts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')).sort().map(name => join(path, name))
            : [path]
        for (const file of entries) {
            try { files.push({ path: file, mtime: statSync(file).mtimeMs }) } catch { /* 列目录和读状态之间被删掉了：跳过 */ }
        }
    }

    // --- 读元数据：缓存命中直接用，已知坏文件跳过，其余每个文件一个子进程并行读 ---
    const metas = await Promise.all(files.map(async ({ path, mtime }): Promise<ToolMeta | null> => {
        const cached = internal.toolCache.get(path)
        if (cached && cached.mtime === mtime) return cached
        const badKey = `bad:${path}@${mtime}`
        if (internal.warned.has(badKey)) return null
        const result = await spawn({ mode: 'meta', path }, internal.procs, { timeout: LOAD_TIMEOUT })
        if (!result.ok) {
            if (result.killed) return null                                       // stop() 杀掉的：不是文件的错。
            internal.warned.add(badKey)
            warn(path, result.timedOut ? `读取工具文件超时（${LOAD_TIMEOUT}ms，可能有顶层死循环），已跳过：${path}` : `工具文件无法加载，已跳过：${result.error}`)
            return null
        }
        const meta: ToolMeta = { ...result.meta, path, mtime }
        internal.toolCache.set(path, meta)
        return meta
    }))

    // --- 去重与清理：同名工具只留第一个；这一轮没出现的路径从缓存里删掉 ---
    const seen = new Set<string>()
    const usable: ToolMeta[] = []
    for (const meta of metas) {
        if (!meta) continue
        if (seen.has(meta.name)) {
            const key = `dup:${meta.path}@${meta.mtime}`
            if (!internal.warned.has(key)) { internal.warned.add(key); warn(meta.path, `工具名 ${meta.name} 重复，已跳过：${meta.path}`) }
            continue
        }
        seen.add(meta.name)
        usable.push(meta)
    }
    const current = new Set(files.map(file => file.path))
    for (const path of internal.toolCache.keys()) if (!current.has(path)) internal.toolCache.delete(path)
    return usable
}
