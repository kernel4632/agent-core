/* 这个文件管一个工具：say_hello。

   它演示工具文件长什么样：默认导出一个纯对象，读起来就像文档——
   name / description / parameters（JSON Schema）/ run(args)。不依赖 agent-core，不需要 import 任何东西。
   宿主只把这个文件（或它所在的目录）的路径交给 Agent；工具在独立的子进程里执行，卡死也能被 stop() 直接杀掉。
*/

export default {
    name: 'say_hello',
    description: '向指定的人打个招呼',
    parameters: {
        type: 'object',
        properties: { who: { type: 'string', description: '要打招呼的对象' } },
        required: ['who'],
    },
    run({ who }: { who: string }) {
        return `你好，${who}！`
    },
}
