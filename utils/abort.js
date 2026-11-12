// 取消错误：名字是 AbortError，带 kind: 'aborted'，调用方按 error.kind 分支即可。
// 整个项目只有这一处造它，措辞和字段不会漂移。
const aborted = () => Object.assign(new DOMException('Agent aborted', 'AbortError'), { kind: 'aborted' })

export default aborted
