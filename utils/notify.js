/*
通知调用方：所有回调统一从这里调用，出错怎么处理只写在这一处。

界面的回调（onStart / onLLMStart / onLLMFinish / onLLMEvent / onToolCall / onToolOutput /
onToolResult / onStep / onRetry / onCompact）只是通知，返回值没人看：出错就忽略。
一个坏掉的展示回调不该让整个任务失败——它和"这次任务成不成功"没有关系。
    await Notify.tell(onStep, { step, result, toolCalls, toolResults })

只有两个回调不从这里走：
- onPermission 的返回值决定放不放行，出错必须让调用方接住；
- onInject 的返回值是"这一轮要不要临时插一句话"，值要用，出错按"不注入"处理。
它们的调用和判定都在 features/loop.js 里。
*/

const tell = async (callback, payload) => {
    try { await callback?.(payload) } catch { /* 通知回调出错不影响任务。 */ }
}

export default { tell }
