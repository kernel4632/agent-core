/*
子进程入口：被 tools/spawn 以文件路径启动（开发时直接跑本文件，打包时连同 shape 内联成一段文本），
主进程从不 import 工具文件，所以工具顶层的死循环、副作用只会卡住这个子进程，stop() 直接 kill 即可。

协议（一行 JSON 进、一行 JSON 出）：
    stdin  ← { mode: 'meta', path }                     读元数据
    stdin  ← { mode: 'run', path, args, limit }         执行一次
    stdout → { ok: true, meta }                         mode 'meta' 的结果（不含 run）
    stdout → { ok: true, output, stop?, truncated? }    mode 'run' 的结果（已经过 shape）
    stdout → { ok: false, error }                       导入失败、契约不符、run 抛错
工具自己 console.log 的内容会和协议行混在一起，所以协议行带一个固定前缀，spawn 只认带前缀的那一行，
其余 stdout / stderr 原样作为工具输出转给宿主（onToolOutput）。

本文件只导入同目录的 shape；动态 import 工具文件。只在作为主模块运行时才读 stdin，被类型检查导入时不执行任何东西。
*/

import type { ToolDefinition } from '../types.ts'
import { shape } from './shape.ts'

// 协议行前缀：不太可能和工具自己的输出撞上。
export const PROTOCOL_PREFIX = '\u0000agent-core:'

// 主进程发来的一条指令。
export type ChildRequest = { mode: 'meta'; path: string } | { mode: 'run'; path: string; args: unknown; limit?: number }

/*
check：校验工具文件的默认导出是否符合契约 { name, description, parameters, run }。
name / description 必须是非空字符串，parameters 必须是 JSON Schema 对象（type: 'object'），run 必须是函数，
timeout 若有必须是正数。不符合时抛出说明哪一项不对的错误，mode 'meta' 会把它作为警告带回给宿主。
*/
export function check(value: unknown, path: string): ToolDefinition {
    throw new Error('TODO')
}

/*
main：读 stdin 的一条指令 → 动态 import 工具文件 → check → 按 mode 读元数据或执行 run（结果交给 shape）
→ 写出一条带前缀的协议行 → 退出。任何异常都变成 { ok: false, error }，退出码仍为 0（由 spawn 统一判断）。
*/
export async function main(): Promise<void> {
    throw new Error('TODO')
}

// 只有被 spawn 当作入口启动时才运行；被 import（类型检查、打包分析）时什么都不做。
if (import.meta.main) await main()
