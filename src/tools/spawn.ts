/*
spawn / killAll：子进程的生命周期。普通工具的每次读取、每次执行都在一个新的子进程里，
停止就是 kill，不给工具任何反应时间（主进程里的函数本质上杀不掉）。

调用示例：
    const result = await spawn({ mode: 'run', path, args, limit }, internal.procs, { timeout, onOutput })
    killAll(internal.procs)   // agent.stop()：只杀本实例的子进程

procs 是 Agent 实例私有的 Set，由调用方传入——放在本模块里会变成全进程共享，一个实例 stop 会杀掉别人的工具。
本文件不 import child.ts：只按路径启动它（开发时是 child.ts 的路径，打包后是内联的那段源码），
所以没有导入边；没有模块级可变状态。
*/

import type { Subprocess } from 'bun'
import type { ChildRequest } from './child.ts'

// 子进程回来的结果：成功时是 child 写出的协议行内容；被杀 / 超时 / 崩溃时 ok 为 false 并说明原因。
export type ChildResult =
    | { ok: true; meta?: unknown; output?: unknown; stop?: boolean; truncated?: boolean }
    | { ok: false; error: string; killed?: boolean; timedOut?: boolean }

/*
spawn：启动一个 child 子进程执行一条指令，等它写出协议行后返回。

- 用 Bun.spawn 启动 `bun <child 入口>`，把指令写进 stdin；启动后立即加入 procs，结束（无论成败）立即移出；
- 带前缀的那一行是结果；其余 stdout / stderr 实时交给 onOutput（宿主显示工具进度）；
- timeout 到了就 kill 并返回 { ok: false, timedOut: true }；
- 被 killAll 杀掉返回 { ok: false, killed: true }，由调用方补"已取消"；
- 进程崩溃、没写协议行就退出，返回 { ok: false, error: 退出码和 stderr 尾部 }。
永远不抛错：工具的错都是结果，交给模型处理。
*/
export async function spawn(
    request: ChildRequest,
    procs: Set<Subprocess>,
    options: { timeout?: number; onOutput?: (stream: 'stdout' | 'stderr', data: string) => void } = {},
): Promise<ChildResult> {
    throw new Error('TODO')
}

/*
killAll：立刻 kill procs 里的全部子进程（SIGKILL，不等它们收尾），并清空集合。
各自的 spawn 调用会因此以 killed 结束。
*/
export function killAll(procs: Set<Subprocess>): void {
    throw new Error('TODO')
}
