// 工具目录里的共享辅助文件：没有默认导出，不是工具。
// scan 必须跳过它而不是崩掉，否则工具作者没地方放共用代码。
export const shared = value => `shared:${value}`
