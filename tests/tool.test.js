/*
盯住工具这条链路：扫描目录、把工具跑在独立子进程里、把结果安全地带回主线程。

这里最贵的一条契约是"一次调用一定会结算"。工具进程可能跑完、抛错、自杀、被超时杀掉、
被取消信号杀掉——五条路径，任何一条没接住，整台 Agent 就会静默卡死。
*/

import { expect, test, describe } from 'bun:test'
import Tool from '../features/tool.js'
import { BLOCK } from '../utils/shape.js'
import { BROKEN, CYCLIC_FORMAT, LIMITS, PROTO, TOOLS } from './helpers.js'

// 工具进程不能 import（它是从 stdin 喂进去的匿名程序），BLOCK 这个"认不认得成形的输出块"的表两边各有一份。
// 校验本身只有一处（主线程的 utils/shape.js，子进程不做校验），这里只盯住 BLOCK 别悄悄跑偏。
const extractSet = (source, name) => {
    const body = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))?.[1] ?? ''
    return new Set([...body.matchAll(/'([^']+)'/g)].map(match => match[1]))
}

describe('输出块类型表', () => {
    test('主线程和工具进程的 BLOCK 完全一致', async () => {
        const source = await Bun.file(new URL('../features/tool-process.js', import.meta.url)).text()
        expect(extractSet(source, 'BLOCK')).toEqual(BLOCK)
    })
})

describe('Tool 扫描', () => {
    test('工具目录里的非工具文件被跳过，不再让整次扫描崩溃', async () => {
        const tools = await Tool.scan(TOOLS) // 这个目录里放着没有默认导出的 helper.js。
        expect(Object.keys(tools.schema).sort()).toEqual(['echo', 'noschema', 'partialschema', 'stream'])
    })

    test('没写 inputSchema 的工具也拿到合法的对象 Schema', async () => {
        const tools = await Tool.scan(TOOLS)
        expect(tools.schema.noschema.inputSchema.jsonSchema).toEqual({ type: 'object', properties: {} }) // 缺了它 Anthropic 和 OpenAI 都会 400。
    })

    test('只写了 properties 没写 type 的工具，参数不会被吞掉', async () => {
        const tools = await Tool.scan(TOOLS)
        expect(tools.schema.partialschema.inputSchema.jsonSchema).toEqual({
            type: 'object',                                          // 缺的 type 补上，
            properties: { path: { type: 'string' } },                // 工具自己写的 properties 一个不丢。
            required: ['path'],
        })
    })

    test('工具按名字定位，文件里排第几完全不影响', async () => {
        const tools = await Tool.scan(BROKEN) // order-a.js 里 second 排在 first 前面。
        const first = await Tool.execute({ name: 'first', input: {}, handlers: tools.handlers })
        const second = await Tool.execute({ name: 'second', input: {}, handlers: tools.handlers })

        expect(first.output.value).toBe('I-am-first')   // 按下标定位时这里会拿到 I-am-second。
        expect(second.output.value).toBe('I-am-second')
    })

    test('handlers 里不再保存下标', async () => {
        const tools = await Tool.scan(TOOLS)
        expect(tools.handlers.echo).toEqual({ url: tools.handlers.echo.url })
    })

    test('TypeScript 写的工具也认得，.d.ts 跳过', async () => {
        // 这个包只跑在 Bun 上，Bun 直接执行 TypeScript。工具作者写 .ts 是很自然的事。
        const tools = await Tool.scan(new URL('./fixtures/typescript', import.meta.url))
        expect(Object.keys(tools.schema)).toEqual(['multiply'])   // .d.ts 只有类型，不能被当成工具加载。

        const result = await Tool.execute({ name: 'multiply', input: { a: 6, b: 7 }, handlers: tools.handlers })
        expect(result.output.value).toBe(42)                      // 真的能在工具进程里执行。
    })
})


describe('Tool 执行', () => {
    test('limit 是个位数时截断仍然生效（不能返回整段原文）', async () => {
        const tools = Tool.adopt([{ name: 'long', execute: async () => 'x'.repeat(500) }])
        const result = await Tool.execute({ name: 'long', input: {}, handlers: tools.handlers, limit: 2 })
        expect(result.output.value).toContain('省略')       // 确实截断了。
        expect(result.output.value.length).toBeLessThan(200) // 不是把 500 字原样返回。
    })

    test('工具读子进程输出时不静默截断（超过内部缓冲上限也完整）', async () => {
        const tools = await Tool.scan(new URL('./fixtures/bigout', import.meta.url))
        const result = await Tool.execute({ name: 'bigout', input: {}, handlers: tools.handlers })
        expect(result.output.value.length).toBe(9 * 1024 * 1024) // 9MB 一块不少；曾经超过 8MB 缓冲就丢。
    })

    test('json 块没有 value 时变成工具失败，而不是毒死 history', async () => {
        const tools = Tool.adopt([{ name: 'j', execute: async () => ({ output: { type: 'json' } }) }])
        const result = await Tool.execute({ name: 'j', input: {}, handlers: tools.handlers, limit: 100 })
        expect(result.output.type).toBe('error-text') // 缺 value 的 json 块会被 AI SDK 本地拒收，挡在边界。
        expect(result.error).toBeTruthy()
    })

    test('工具返回循环引用时变成一条工具错误，而不是毒死 history', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'cyclic', input: {}, handlers: tools.handlers })

        expect(result.error).toBeTruthy()
        expect(result.output.type).toBe('error-text')
        expect(() => JSON.stringify(result.output)).not.toThrow() // 写进 history 之后 Context.build 还得能序列化它。
    })

    test('Date / Map / NaN 被规整成纯 JSON 再跨进程', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'rich', input: {}, handlers: tools.handlers })

        expect(result.output.value.when).toBe('2020-01-02T03:04:05.000Z') // Date 变字符串。
        expect(result.output.value.map).toEqual({})                       // Map 没有 JSON 表示。
        expect(result.output.value.bad).toBeNull()                        // NaN 变 null，AI SDK 才收。
    })

    test('带方法的类实例不再让成功的工具被报成失败', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'uncloneable', input: {}, handlers: tools.handlers })

        expect(result.error).toBeUndefined()        // 以前这里是 DataCloneError，模型会以为工具失败而重试。
        expect(result.output.value).toEqual({ value: 42 })
    })

    test('toModelOutput 抛错时这次调用仍然会结算', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'badformat', input: {}, handlers: tools.handlers }) // 以前这里永远挂着，整台 Agent 卡死。

        expect(result.error).toBeTruthy()
        expect(result.output.type).toBe('error-text')
    })

    test('工具把工具进程杀掉时这次调用仍然会结算', async () => {
        const tools = await Tool.scan(BROKEN)
        const result = await Tool.execute({ name: 'suicide', input: {}, handlers: tools.handlers }) // 以前只触发 close 事件，没人监听。

        expect(result.error).toBeTruthy()
        expect(result.output.value).toContain('工具进程')
    })

    test('工具进程被杀之后还能继续执行工具', async () => {
        const tools = await Tool.scan(BROKEN)
        await Tool.execute({ name: 'suicide', input: {}, handlers: tools.handlers })
        const after = await Tool.execute({ name: 'first', input: {}, handlers: tools.handlers })

        expect(after.output.value).toBe('I-am-first') // 工具进程塌了会自动重建，不需要调用方做任何事。
    })

    test('取消信号能瞬间杀掉死循环工具', async () => {
        const tools = await Tool.scan(BROKEN)
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 100)

        const started = Date.now()
        const result = await Tool.execute({ name: 'forever', input: {}, handlers: tools.handlers, signal: controller.signal })

        expect(result.interrupted).toBe(true)
        expect(Date.now() - started).toBeLessThan(2000) // 进程内的 await 永远做不到这件事，所以工具必须跑在独立进程里。
    })

    test('每次调用都是新进程、跑完就杀：不复用，内存也不累积', async () => {
        const tools = await Tool.scan(LIMITS, TOOLS)
        const ids = []
        for (let i = 0; i < 3; i += 1) ids.push((await Tool.execute({ name: 'wid', input: { hold: 0 }, handlers: tools.handlers })).output.value)
        expect(new Set(ids).size).toBe(3) // 三个独立进程：不复用，也就不存在"上一次的工具状态漏给下一次"。

        const before = process.memoryUsage.rss()
        for (let i = 0; i < 20; i += 1) await Tool.execute({ name: 'echo', input: { value: String(i) }, handlers: tools.handlers })
        const grew = (process.memoryUsage.rss() - before) / 1048576

        expect(grew).toBeLessThan(200) // 进程用完就杀，跑多少次主进程都不累积（常驻复用反而会一直占着）。
    })

    test('signal 进来之前就已经取消时，这次调用立刻结算而不是永远挂着', async () => {
        const tools = await Tool.scan(TOOLS)
        const controller = new AbortController()
        controller.abort() // 先取消，再调用——agent.stop() 之后残留的工具调用就是这个形状。

        const result = await Promise.race([
            Tool.execute({ name: 'echo', input: { value: 'x' }, handlers: tools.handlers, signal: controller.signal }),
            Bun.sleep(2000).then(() => 'HUNG'), // 挂住的话这条先到，测试失败。
        ])

        expect(result).not.toBe('HUNG')
        expect(result.interrupted).toBe(true)
    })

    test('取消只杀自己这一轮的工具，不误伤共用同一份工具的另一个调用', async () => {
        const tools = await Tool.scan(BROKEN)
        const mine = new AbortController()
        const theirs = new AbortController()

        const victim = Tool.execute({ name: 'forever', input: {}, handlers: tools.handlers, signal: mine.signal })
        const bystander = Tool.execute({ name: 'first', input: {}, handlers: tools.handlers, signal: theirs.signal })
        setTimeout(() => mine.abort(), 80)

        expect((await victim).interrupted).toBe(true)
        expect((await bystander).output.value).toBe('I-am-first') // 以前这里会被连坐杀掉，拿到"工具执行已中断"。
    })

    test('跑过工具之后进程还能正常退出', async () => {
        // 工具进程跑完就杀、不留常驻进程，所以事件循环一定能在调用结束后变空。
        const child = Bun.spawn(['bun', '-e', `
            import Tool from '${new URL('../features/tool.js', import.meta.url).href}'
            const tools = await Tool.scan('./tests/fixtures/tools')
            await Tool.execute({ name: 'echo', input: { value: 'bye' }, handlers: tools.handlers })
            console.log('done')
        `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })

        const exited = await Promise.race([child.exited, Bun.sleep(8000).then(() => 'HUNG')])
        if (exited === 'HUNG') child.kill()

        expect(exited).toBe(0)
    })

    test('工具进程起不来时立刻返回错误，而不是永远挂着', async () => {
        // spawn 会失败：bun 不在 PATH、系统进程数满。以前这次调用永远不结算，
        // 整个 Agent 无声卡死。用子进程跑，避免前面的用例留下还在跑的进程干扰计时。
        const child = Bun.spawn(['bun', '-e', `
            import Tool from '${new URL('../features/tool.js', import.meta.url).href}'
            const tools = await Tool.scan('./tests/fixtures/tools')
            Bun.spawn = () => { throw new Error('bun 不在 PATH') }
            const result = await Tool.execute({ name: 'echo', input: { value: 'x' }, handlers: tools.handlers })
            console.log(result.error ? 'ERROR:' + result.error : 'NOERROR')
        `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })

        const exited = await Promise.race([child.exited.then(() => child.stdout.text()), Bun.sleep(8000).then(() => 'HUNG')])
        if (exited === 'HUNG') child.kill()

        expect(exited).toContain('ERROR') // 挂住的话这里拿到 HUNG，测试失败。
        expect(exited).not.toBe('HUNG')
    })

    test('工具进程握手完成前就死掉时，调用立刻失败而不是挂住', async () => {
        // 进程能起来、但在发出 ready 之前就退出（runtime 不对、bun - 不支持、启动即 OOM）。
        // 这种情况 pool.busy 里还没有这次调用，finish 拿不到它，必须由 borrow 一侧解除挂起。
        const child = Bun.spawn(['bun', '-e', `
            import Tool from '${new URL('../features/tool.js', import.meta.url).href}'
            const tools = await Tool.scan('./tests/fixtures/tools')
            // 假进程：能起、能收 stdin，但立刻 exited，从不发 ready。
            Bun.spawn = () => ({
                stdin: { write() {}, end() {} },
                unref() {}, ref() {}, send() {}, kill() {},
                get exited() { return Promise.resolve(1) },
            })
            const result = await Tool.execute({ name: 'echo', input: { value: 'x' }, handlers: tools.handlers })
            console.log(result.error ? 'ERROR:' + result.error : 'NOERROR')
        `], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })

        const exited = await Promise.race([child.exited.then(() => child.stdout.text()), Bun.sleep(8000).then(() => 'HUNG')])
        if (exited === 'HUNG') child.kill()

        expect(exited).not.toBe('HUNG') // 挂住的话这里失败。
        expect(exited).toContain('ERROR')
    })

    test('自带 toModelOutput 的工具返回循环引用时也不会毒化 history', async () => {
        const tools = await Tool.scan(CYCLIC_FORMAT)
        const result = await Tool.execute({ name: 'cyclicformat', input: {}, handlers: tools.handlers })

        expect(result.error).toBeTruthy()                              // 成形结果同样要过 JSON 化这一关，不能因为工具自带格式化就放行。
        expect(() => JSON.stringify(result.output)).not.toThrow()
    })

    test('并发调用不会串台', async () => {
        const tools = await Tool.scan(TOOLS)
        const values = ['a', 'b', 'c', 'd']
        const results = await Promise.all(values.map(value => Tool.execute({ name: 'echo', input: { value }, handlers: tools.handlers })))

        expect(results.map(result => result.output.value)).toEqual(values.map(value => `done:${value}`))
    })

    test('工具名写成 __proto__ 也不会污染原型链', async () => {
        // 工具目录里放一个 name: '__proto__' 的文件：如果工具表是普通对象，
        // schema['__proto__'] = … 走的是 setter，会把这张表的原型改成另一份对象，
        // 别人的工具表跟着受影响。null 原型 + 认 url 而不是认对象挡住了这两条路。
        const tools = await Tool.scan(PROTO)

        expect(Object.getPrototypeOf(tools.handlers)).toBeNull()          // 工具表本身没有可被踩的原型。
        expect(Object.getPrototypeOf(tools.schema)).toBeNull()
        expect(tools.handlers['__proto__']?.url).toBeTruthy()             // 名字怪，但工具本身照样找得到。
        expect(({}).url).toBeUndefined()                                  // 全局对象没被写脏。
        expect(({}).timeout).toBeUndefined()

        const result = await Tool.execute({ name: '__proto__', input: {}, handlers: tools.handlers })
        expect(result.output.value).toEqual({ value: 'ok' })
    })
})
