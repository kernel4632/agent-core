/*
本地 token 估算：不装分词器，改用"字符数 × 每字符多少 token"来估。

调用示例：
    estimate({ messages, tools })                                   // 估一段内容的 token 数（用默认比例）
    const meter = createMeter()                                     // 一个按模型记账、会自校准的估算器
    meter.observe(modelKey(llm), payload, usage.inputTokens)        // 用真实 usage 校准这个模型的比例
    meter.ratio(modelKey(llm))                                      // 取这个模型当前的比例，交给 estimate

比例是**会自校准**的：每轮模型都会回 usage.inputTokens（这一次请求真实的总输入 token 数），
拿它除以这次发出去内容的字符数，就得到这个模型真实的"每字符 token 比"，记下来给下一轮用。
换模型就换一条记录，越用越准——不需要内置任何分词表。

**媒体块不按字符数算。** 图片 / 音频 / 视频 / 文件在 JSON 里是一大段 base64（一张 1MB 的截图
就是 140 万字符），但模型为它付多少 token 只取决于尺寸和解码方式，跟这段字符串的长短没关系。
所以量长度时先把媒体载荷换成短标记，每块按固定的 MEDIA_TOKENS 计：
实战里见过一张图把 JSON 从 100 万字符顶到 4700 万字符，旧算法把真实 14.5 万 token 的请求估成
80 万+，上下文还很空就触发了压缩。校准也一样：真实 usage 里先减掉媒体的固定估值，
剩下的才归给"每字符多少 token"，否则一张图就能把学到的比例拉到接近 0，之后所有纯文字请求都会低估。

为什么不内置分词器：一张分词表只对应一个模型，而这个包会在一轮任务里换模型
（config.compact 的压缩模型、send 时覆盖 model、换 provider），换一次分词器就错一次。
用真实 usage 反推则天然跟着模型走。

默认比例取得偏大（宁可高估、早一点压缩，也不要低估、把上下文撑爆）。
*/

export const DEFAULT_RATIO = 0.6 // 每字符大约多少 token。偏高：未知模型时宁可早压缩。
// 一个媒体块按多少 token 估。各家算法不同：OpenAI 1024×1024 高细节约 765，Claude 同尺寸约 1400，
// 而低细节模式只要 85。取 1200 偏保守——宁可把图算贵一点，也别让真实请求把窗口撑爆。
export const MEDIA_TOKENS = 1200

const MIN_RATIO = 0.1
const MAX_RATIO = 2
const SMOOTH = 0.3 // 新样本占的权重；越小越稳，越大越快跟上。
const MIN_CHARS = 200 // 内容太短时字符数抖动大，算出来的比例不可靠，不值得采信。

const clamp = ratio => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))

// 这几个 type 的内容块装的是媒体本身，不是文字。
const MEDIA = new Set(['image', 'audio', 'video', 'file', 'file-data', 'file-url'])
// 媒体块里真正装字节 / 网址的字段，换成标记后不参与字符统计。
const CARRIER = new Set(['image', 'audio', 'video', 'data', 'url'])

const isBinary = value => value instanceof Uint8Array || value instanceof ArrayBuffer || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))

// 给一个模型起个稳定的名字：换地址、换协议、换模型名都会算作不同模型。
export const modelKey = llm => {
    if (typeof llm?.model === 'string') return `${llm.protocol ?? ''}|${llm.baseURL ?? ''}|${llm.model}`
    const model = llm?.model
    return `${model?.provider ?? ''}|${model?.modelId ?? ''}`
}

// --- 量一份 payload：文字有多少字符，里面有几个媒体块 ---
// 媒体载荷（base64 / data URL / 网址 / 二进制）在这里换成短标记，不进入字符数：
// 它们在 JSON 里的长度只反映编码方式，和模型真正读进去多少 token 没有关系。
// 纯文字 payload 量出来和 JSON.stringify 的长度完全一样，所以原来的校准数据仍然有效。
const measure = payload => {
    let media = 0
    const walk = value => {
        if (isBinary(value)) return '#bytes#'          // 二进制直接序列化成 {"0":137,...}，长度会翻几十倍。
        if (Array.isArray(value)) return value.map(walk)
        if (!value || typeof value !== 'object') return value
        if (MEDIA.has(value.type)) {                   // 媒体块：只记"有一个媒体"，载荷换成标记。
            media += 1
            return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, CARRIER.has(key) ? '#media#' : walk(one)]))
        }
        return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, walk(one)]))
    }
    return { chars: JSON.stringify(walk(payload)).length, media }
}

// 估一段内容：token 和它的两个组成部分一起返回。
// chars / media 是给诊断用的：token = ceil(chars × ratio) + media × MEDIA_TOKENS，
// 排查"怎么估出这么多"时，看这两个数就知道是内容多还是比例高。
export const estimateDetails = (payload, ratio = DEFAULT_RATIO) => {
    const { chars, media } = measure(payload)
    return { token: Math.ceil(chars * clamp(ratio)) + media * MEDIA_TOKENS, chars, media }
}

// 估一段内容的 token：文字按字符数 × 比例，媒体按块数 × 固定值。
export const estimate = (payload, ratio = DEFAULT_RATIO) => estimateDetails(payload, ratio).token

// 只数文字有多少字符，媒体载荷不算。Context 按字符给回合分预算时也用这一份，
// 否则一张图会把整轮算成"超大的回合"，在压缩后被整个丢掉。
export const textChars = payload => measure(payload).chars

// --- 一个按模型记账、会自校准的估算器 ---
// 比例的来源有三层，优先级从高到低：
//   1. 真实 usage 学到的（ratios 里这个模型的记录）；
//   2. 宿主传进来的冷启动倍率（seed）——进程重启、恢复大 history 时，第一次估算就不用默认值；
//   3. DEFAULT_RATIO。
// seed 只是冷启动用：一旦学到真实值就被覆盖；上游不回 usage 时它一直有效（不会被重置回默认）。
export const createMeter = () => {
    const ratios = new Map() // 模型名 → 每字符 token 比（从真实 usage 学到的）
    let seed = null          // 宿主给的冷启动倍率；null 表示没传。

    return {
        // 某个模型当前用的比例：学到的优先，其次宿主 seed，最后默认值。
        ratio: key => ratios.get(key) ?? seed ?? DEFAULT_RATIO,
        // 这个模型有没有被真实 usage 校准过。
        calibrated: key => ratios.has(key),
        // 这个比例是从哪来的，宿主据此决定要不要把自己的 seed 当成"已校准"。
        source: key => ratios.has(key) ? 'usage' : seed === null ? 'default' : 'host',
        // 宿主冷启动：没有学到值之前先用它。非法值（非正数 / 非有限数）当没传。
        seed: value => { seed = Number.isFinite(value) && value > 0 ? value : null },
        // 忘掉某个模型学到的值：显式设置倍率后要从它重新开始校准。
        forget: key => { ratios.delete(key) },
        // 观测一次真实结果：payload 是这次发出去的内容，real 是模型回的真实输入 token 数。
        observe: (key, payload, real) => {
            if (!key || !Number.isFinite(real) || real <= 0) return
            const { chars, media } = measure(payload)
            const text = real - media * MEDIA_TOKENS // 先扣掉媒体的固定估值，剩下的才是文字那部分。
            if (text <= 0) return                    // 这一笔几乎全是媒体，学不到文字比例。
            if (chars < MIN_CHARS) return            // 太短的内容不采：比例噪声大。
            const sample = clamp(text / chars)
            const old = ratios.get(key)              // 只和"真正学到的值"比：seed 是宿主的猜测，不能拿它当离群判据，否则猜错时会把真实样本全拒掉。
            // 已经有比例时，和新样本差太远（3 倍以上）的当成异常用量丢掉，别让一次离群值把估算带偏。
            if (old !== undefined && (sample > old * 3 || sample < old / 3)) return
            ratios.set(key, old === undefined ? sample : old * (1 - SMOOTH) + sample * SMOOTH)
        },
    }
}
