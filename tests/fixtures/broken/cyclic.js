const first = { name: 'cyclic', description: '返回循环引用对象', inputSchema: { type: 'object', properties: {} },
    async execute() { const root = { id: 1 }; root.self = root; return root } }

const rich = { name: 'rich', description: '返回 Date / Map / NaN', inputSchema: { type: 'object', properties: {} },
    async execute() { return { when: new Date('2020-01-02T03:04:05Z'), map: new Map([['a', 1]]), bad: NaN } } }

const badFormat = { name: 'badformat', description: 'toModelOutput 会抛错', inputSchema: { type: 'object', properties: {} },
    async execute() { return null },
    toModelOutput(value) { return { type: 'text', value: value.missing.deep } } }

const suicide = { name: 'suicide', description: '直接杀掉自己所在的进程', inputSchema: { type: 'object', properties: {} },
    async execute() { process.exit(7) } }

const forever = { name: 'forever', description: '永不返回', inputSchema: { type: 'object', properties: {} },
    async execute() { while (true) await Bun.sleep(10) } }

const uncloneable = { name: 'uncloneable', description: '返回带方法的类实例', inputSchema: { type: 'object', properties: {} },
    async execute() { return { greet() { return 'hi' }, value: 42 } } }

export default [first, rich, badFormat, suicide, forever, uncloneable]
