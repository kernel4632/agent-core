/*
通知调用方：所有回调统一从这里调用，出错怎么处理只写在这一处。

界面的回调（onStart / onLLMStart / onLLMFinish / onLLMEvent / onToolCall / onToolOutput /
onToolResult / onStep / onRetry / onCompact）只是通知，返回值没人看：出错就忽略。
一个坏掉的展示回调不该让整个任务失败——它和"这次任务成不成功"没有关系。
    await Notify.tell(onStep, { step, result, toolCalls, toolResults })

只有 onPermission 的返回值决定放行，出错必须让调用方接住，所以不从这里走：
它的调用和判定（严格 true 才放行）在 features/loop.js 里。
*/

const tell = async (callback, payload) => {
    try { await callback?.(payload) } catch { /* 通知回调出错不影响任务。 */ }
}

export default { tell }
