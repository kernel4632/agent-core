// 同一个文件里两个工具。按下标定位时，调换顺序就会执行错工具；按名字定位则不受影响。
export default [
    { name: 'second', description: '排在后面', inputSchema: { type: 'object', properties: {} }, async execute() { return 'I-am-second' } },
    { name: 'first', description: '排在前面', inputSchema: { type: 'object', properties: {} }, async execute() { return 'I-am-first' } },
]
