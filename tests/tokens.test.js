/*
盯住 token 估算器：不装分词器，靠"字符数 × 每字符 token 比"，比例随真实 usage 自校准。

这里要守住三件事：
1. 估算随内容单调增长（不会把大内容估成小的）。
2. 拿到真实 usage 后，比例会朝真实值靠；换模型各记各的。
3. 媒体按块算，不按 base64 字符数——一张图不该把估算撑到几十倍（实战里真实 14.5 万 token 估成 80 万+）。
*/

import { expect, test, describe } from 'bun:test'
import { estimate, estimateDetails, createMeter, modelKey, DEFAULT_RATIO, MEDIA_TOKENS } from '../utils/tokens.js'

describe('token 估算器', () => {
    test('估算随内容增长，默认比例偏高', () => {
        const small = estimate({ messages: [{ role: 'user', content: '你好' }] })
        const big = estimate({ messages: [{ role: 'user', content: '你好'.repeat(100) }] })
        expect(big).toBeGreaterThan(small)
        expect(DEFAULT_RATIO).toBeGreaterThan(0) // 未知模型时也给一个正的、偏高的估计。
    })

    test('拿到真实 usage 后比例自校准，并平滑跟进', () => {
        const meter = createMeter()
        const key = 'chat|http://x|m'
        expect(meter.ratio(key)).toBe(DEFAULT_RATIO) // 还没数据，用默认。

        const payload = { messages: [{ role: 'user', content: 'a'.repeat(1000) }] }
        const chars = JSON.stringify(payload).length
        meter.observe(key, payload, Math.round(chars * 0.25)) // 真实比是 0.25。

        const after = meter.ratio(key)
        expect(after).toBeLessThan(DEFAULT_RATIO) // 朝真实值（更低）靠了。
        expect(after).toBeGreaterThan(0.25 - 1e-9) // 平滑，不会一步跳到底。
    })

    test('按模型各记各的，换模型互不影响', () => {
        const meter = createMeter()
        const payload = { messages: [{ role: 'user', content: 'a'.repeat(1000) }] }
        const chars = JSON.stringify(payload).length
        meter.observe('chat|http://a|m1', payload, Math.round(chars * 0.8))
        expect(meter.ratio('chat|http://a|m2')).toBe(DEFAULT_RATIO) // 另一个模型没数据。
        expect(meter.ratio('chat|http://a|m1')).not.toBe(DEFAULT_RATIO)
    })

    test('坏数据不污染比例', () => {
        const meter = createMeter()
        const payload = { messages: [{ role: 'user', content: 'a'.repeat(1000) }] }
        meter.observe('k', payload, undefined) // 没有 usage。
        meter.observe('k', payload, 0)
        meter.observe('k', payload, -5)
        expect(meter.ratio('k')).toBe(DEFAULT_RATIO)
    })

    test('太短的样本不采信，离群样本被丢掉', () => {
        const meter = createMeter()
        const big = { messages: [{ role: 'user', content: 'a'.repeat(1000) }] }
        const chars = JSON.stringify(big).length
        meter.observe('k', big, Math.round(chars * 0.25)) // 稳定在 0.25。
        const settled = meter.ratio('k')

        meter.observe('k', { messages: [] }, 1000000) // 内容太短 → 直接忽略，不参与计算。
        expect(meter.ratio('k')).toBe(settled)

        meter.observe('k', big, Math.round(chars * 3)) // 偏差 >3 倍 → 当成异常用量丢掉。
        expect(meter.ratio('k')).toBe(settled)
    })

    test('modelKey 能区分地址 / 协议 / 模型名', () => {
        expect(modelKey({ protocol: 'chat', baseURL: 'u', model: 'm' })).not.toBe(modelKey({ protocol: 'chat', baseURL: 'u', model: 'm2' }))
        expect(modelKey({ protocol: 'chat', baseURL: 'u', model: 'm' })).not.toBe(modelKey({ protocol: 'anthropic', baseURL: 'u', model: 'm' }))
        expect(modelKey({ model: { provider: 'openai', modelId: 'gpt' } })).toBe('openai|gpt')
    })

    test('estimateDetails 给出 token 的两个组成部分，和 estimate 一致', () => {
        const payload = { messages: [{ role: 'user', content: 'a'.repeat(1000) }] }
        const details = estimateDetails(payload, 0.25)

        expect(details.token).toBe(estimate(payload, 0.25))
        expect(details.chars).toBeGreaterThan(1000) // 含 JSON 结构本身的字符。
        expect(details.media).toBe(0)
    })

    test('meter.known：没观测过是 false，观测一次后变 true', () => {
        const meter = createMeter()
        const payload = { messages: [{ role: 'user', content: 'a'.repeat(1000) }] }

        expect(meter.known('k')).toBe(false) // 还是默认比例，说明没拿到真实 usage 校准过。
        meter.observe('k', payload, Math.round(JSON.stringify(payload).length * 0.25))
        expect(meter.known('k')).toBe(true)
    })
})


describe('媒体不按字符数算', () => {
    // 实战：一张图让 JSON 从 100 万字符涨到 4700 万字符，旧算法估出 80 万 token，
    // 真实 input 只有 14.5 万，于是上下文还很空就触发了压缩。
    test('图片的 base64 有多长，估出来都一样', () => {
        const withImage = data => ({ messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', image: data }] }] })
        const small = estimate(withImage('data:image/png;base64,AAAA'))
        const huge = estimate(withImage('data:image/png;base64,' + 'A'.repeat(2_000_000)))

        expect(huge).toBe(small)                      // 2MB 的图和 4 字节的图，估出来完全一样。
        expect(huge).toBeLessThan(MEDIA_TOKENS + 100) // 整个请求 = 一句话 + 一块媒体。
    })

    test('媒体按块计固定 token，文字照常按字符算', () => {
        const one = { messages: [{ role: 'user', content: [{ type: 'image', image: 'x' }] }] }
        const two = { messages: [{ role: 'user', content: [{ type: 'image', image: 'x' }, { type: 'image', image: 'y' }] }] }
        const delta = estimate(two) - estimate(one)

        expect(delta).toBeGreaterThanOrEqual(MEDIA_TOKENS) // 多一块媒体至少多一份固定值。
        expect(delta).toBeLessThan(MEDIA_TOKENS + 100)     // 但不会跟着载荷长度涨。
        expect(estimate({ messages: [{ role: 'user', content: 'a'.repeat(3000) }] })).toBeGreaterThan(estimate(one)) // 文字仍然按字符估。
    })

    test('二进制媒体不会被 JSON 化后算成几十倍', () => {
        const bytes = new Uint8Array(500_000).fill(65)
        const binary = estimate({ messages: [{ role: 'user', content: [{ type: 'image', image: bytes }] }] })
        const text = estimate({ messages: [{ role: 'user', content: [{ type: 'image', image: 'x' }] }] })
        expect(binary).toBe(text) // Uint8Array 序列化成 {"0":65,...} 的长度完全失真，这里直接按媒体块算。
    })

    test('工具结果里的媒体同样按块算', () => {
        const output = {
            type: 'content',
            value: [{ type: 'text', text: '截图' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'A'.repeat(1_000_000) } }],
        }
        const messages = [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'shot', output }] }]
        expect(estimate({ messages })).toBeLessThan(MEDIA_TOKENS + 200)
    })

    test('校准先扣掉媒体的固定估值，一张图不会把文字比例拉到接近 0', () => {
        const meter = createMeter()
        const payload = {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(1000) }, { type: 'image', image: 'data:image/png;base64,' + 'A'.repeat(2_000_000) }] }],
        }
        meter.observe('k', payload, estimate(payload, 0.25)) // 真实用量 ≈ 文字按 0.25 估 + 图上固定的 MEDIA_TOKENS。

        expect(meter.ratio('k')).toBeCloseTo(0.25, 1) // 学到的还是文字比例；旧算法在这里会掉到 MIN_RATIO。
    })
})
