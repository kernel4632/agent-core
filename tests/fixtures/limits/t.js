// 每个工具进程首次加载时生成自己的身份，用来数到底起了几个工具进程。
globalThis.__WID__ ??= Math.random().toString(36).slice(2, 8)

// 这一批活同时有几个在跑。
// 工具跑在独立进程里，没法共享内存计数器（"每个进程自己的计数器"只能反映单个进程里的重叠，
// 反映不了池子里同时有几个在跑），所以每个调用回报自己的占用区间，由测试方在主线程里合并区间。
// 并发上限约束的是"同时几个"，不是"总共用过几个进程"——只有重叠数能反映它。
const hold = async (start, ms) => { await Bun.sleep(ms); return { start, end: Date.now() } }

export default [
    { name: 'big', description: '返回一大坨文本（模拟 cat 大日志）',
      inputSchema: { type: 'object', properties: { kb: { type: 'number' } }, required: ['kb'] },
      async execute(input) { return 'x'.repeat(input.kb * 1024) } },

    { name: 'wid', description: '报告自己跑在哪个工具进程里',
      inputSchema: { type: 'object', properties: { hold: { type: 'number' } } },
      async execute(input) { await Bun.sleep(input.hold ?? 80); return globalThis.__WID__ } },

    { name: 'span', description: '报告自己这次调用占用的时间区间，用来算真实并发',
      inputSchema: { type: 'object', properties: { hold: { type: 'number' } } },
      async execute(input) { return hold(Date.now(), input.hold ?? 150) } },

    { name: 'impatient', description: '跑很久，但自己声明了超时', timeout: 250,
      inputSchema: { type: 'object', properties: {} },
      async execute() { await Bun.sleep(30000); return 'never' } },

    { name: 'blocking', description: '阻塞型工具，没声明超时——这是被支持的正常用法',
      inputSchema: { type: 'object', properties: {} },
      async execute() { await Bun.sleep(500); return 'blocked-then-done' } },

    // 边跑边不停输出的阻塞型工具：盯日志、盯设备就是这个形态。
    // 取消它的时候，主线程攒下来的那份实时输出必须是有界的。
    { name: 'chatty', description: '不停输出，永不返回',
      inputSchema: { type: 'object', properties: {} },
      async execute() { while (true) { console.log('x'.repeat(2000)); await Bun.sleep(1) } } },
]
