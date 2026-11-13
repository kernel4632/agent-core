/*
本地 token 估算：不装分词器，按"字符数 × 每字符 token 比例"估，再用真实 usage 校准比例。

调用示例：
    const ratio = current(state.ratios, config.model, state.contextRatio)   // 这个模型现在用的比例
    const { tokens } = estimate({ system, messages, tools }, ratio)          // 估一份请求
    calibrate(state.ratios, config.model, payload, reply.usage.inputTokens)  // 用真实 usage 修正比例

比例的键只用模型名（不区分协议 / 地址 / 服务商）：默认 0.6 非常保守，DeepSeek、Claude 这类模型
真实可能只有 0.15 左右，学到真实值要很多轮，所以同一模型跨服务商共用一份，只学一次。

比例的来源优先级：ratios 里学到的 > 宿主给的冷启动 contextRatio > DEFAULT_RATIO。
ratios 是 Agent 的公开状态（{ 模型名: 比例 }），宿主直接读写、自行持久化；本文件不持有任何状态，
只对传进来的对象做读写。

媒体块不按字符数算：一张图的 base64 动辄上百万字符，但模型只按尺寸计费，所以每块按固定 MEDIA_TOKENS 估，
校准时也先扣掉这部分，否则一张图就能把学到的比例拉到接近 0。
*/

import type { ModelInput, Usage } from '../types.ts'

export const DEFAULT_RATIO = 0.6   // 每字符多少 token；偏高，宁可早压缩也不撑爆上下文
export const MEDIA_TOKENS = 1200   // 一个媒体块按多少 token 估；偏保守

const MIN_RATIO = 0.1              // 比例下限：再低就是测量噪声
const MAX_RATIO = 2                // 比例上限
const SMOOTH = 0.3                 // 新样本占的权重；越小越稳，越大越快跟上
const MIN_CHARS = 200              // 内容太短时字符数抖动大，不采信
// 这几个 type 的内容块装的是媒体本身；CARRIER 是其中真正装字节 / 网址的字段，换成标记后不计长度。
const MEDIA = new Set(['image', 'audio', 'video', 'file', 'file-data', 'file-url'])
const CARRIER = new Set(['image', 'audio', 'video', 'data', 'url'])

// 把比例夹在合理范围内（estimate 和 calibrate 都要用，所以抽出来）。
const clamp = (ratio: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))

// 量一份内容：文字有多少字符、里面有几个媒体块（estimate 和 calibrate 共用同一把尺子，校准才对得上）。
// 二进制直接序列化会变成 {"0":137,...}，媒体载荷长度只反映编码方式，都换成短标记。
function measure(payload: unknown): { chars: number; media: number } {
    let media = 0
    const walk = (value: any): any => {
        if (value instanceof Uint8Array || value instanceof ArrayBuffer) return '#bytes#'
        if (Array.isArray(value)) return value.map(walk)
        if (!value || typeof value !== 'object' || value instanceof URL) return value instanceof URL ? '#url#' : value
        if (MEDIA.has(value.type)) {                                     // 媒体块：只记"有一个"，载荷换成标记。
            media += 1
            return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, CARRIER.has(key) ? '#media#' : walk(one)]))
        }
        return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, walk(one)]))
    }
    return { chars: (JSON.stringify(walk(payload)) ?? '').length, media }
}

/*
modelName：比例表的键。字符串模型就是它本身；AI SDK 模型实例取 modelId。
不拼协议和地址——见文件头"跨服务商共用"的理由。
*/
export function modelName(model: ModelInput): string {
    if (typeof model === 'string') return model
    return (model as { modelId?: string }).modelId ?? ''                 // AI SDK 模型实例都有 modelId。
}

/*
current：这个模型现在该用的比例。学到的优先，其次宿主的冷启动值，最后默认值。
冷启动值只在没学到之前生效；上游从不回 usage 时它一直有效。
*/
export function current(ratios: Record<string, number>, model: ModelInput, seed?: number): number {
    const learned = ratios[modelName(model)]
    if (typeof learned === 'number' && Number.isFinite(learned) && learned > 0) return learned  // 宿主手写的坏值当没有。
    if (typeof seed === 'number' && Number.isFinite(seed) && seed > 0) return seed
    return DEFAULT_RATIO
}

/*
estimate：估一份内容的 token。先把媒体载荷换成短标记再量字符数（二进制、data URL、网址都不算长度），
token = ceil(chars × ratio) + media × MEDIA_TOKENS。chars / media 一起返回，诊断"为什么估这么多"时用。
*/
export function estimate(payload: unknown, ratio: number): { tokens: number; chars: number; media: number } {
    const { chars, media } = measure(payload)
    return { tokens: Math.ceil(chars * clamp(ratio)) + media * MEDIA_TOKENS, chars, media }
}

/*
calibrate：用一次真实 usage 修正这个模型的比例，原地写进 ratios。

- real（真实输入 token）先扣掉媒体固定估值，剩下的除以字符数得到样本比例，夹在 [0.1, 2]；
- 内容太短（< 200 字符）、样本无效、几乎全是媒体时不采信；
- 已有学到的值时，与新样本相差 3 倍以上的当离群值丢掉（只和学到的值比，不和冷启动值比）；
- 平滑更新：新值 = 旧值 × 0.7 + 样本 × 0.3；第一次直接采用样本。
返回更新后的比例（没采信就返回原值），方便调用方顺手发诊断。
*/
export function calibrate(ratios: Record<string, number>, model: ModelInput, payload: unknown, real: Usage['inputTokens']): number {
    const key = modelName(model)
    const old = ratios[key]                                              // 只和"学到的值"比：冷启动值是宿主的猜测，不能当离群判据。
    if (!key || !Number.isFinite(real) || real <= 0) return old ?? DEFAULT_RATIO // 上游没回 usage：学不到。
    const { chars, media } = measure(payload)
    const text = real - media * MEDIA_TOKENS                             // 先扣掉媒体的固定估值，剩下才归给文字。
    if (text <= 0 || chars < MIN_CHARS) return old ?? DEFAULT_RATIO      // 几乎全是媒体、或内容太短：样本不可靠。
    const sample = clamp(text / chars)
    if (old !== undefined && (sample > old * 3 || sample < old / 3)) return old // 离群值丢掉，别让一次异常用量带偏。
    ratios[key] = old === undefined ? sample : old * (1 - SMOOTH) + sample * SMOOTH
    return ratios[key]!
}
