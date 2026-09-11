export default {
    name: 'partialschema',
    description: '只写了 properties，没写 type 的工具',
    inputSchema: {
        properties: { path: { type: 'string' } },
        required: ['path'],
    },
    async execute(input) { return `read:${input.path}` },
}
