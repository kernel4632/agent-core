// toModelOutput 自己产出一个循环引用的结果：成形这一步也必须过 JSON 化，否则照样把 history 毒死。
export default {
    name: 'cyclicformat',
    description: '自带格式化函数，且格式化结果带循环引用',
    inputSchema: { type: 'object', properties: {} },
    async execute() { return 'ok' },
    toModelOutput() {
        const root = { id: 1 }
        root.self = root
        return { type: 'json', value: root }
    },
}
