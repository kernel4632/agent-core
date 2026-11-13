/*
configure：把"统一请求数据"翻译成 AI SDK generateText / streamText 的调用参数。

调用示例（在 model/ask 里）：
    const call = configure(request)   // { model, system, messages, maxOutputTokens, providerOptions, headers, ... }

翻译内容：
- 连接：model 是字符串时按 protocol 选 provider 现连（chat → openai-compatible，responses → openai，
  anthropic → anthropic，gemini → google），用 baseURL / apiKey；是模型实例就原样用（保留宿主自定义的中间件）；
- 生成参数：maxTokens → maxOutputTokens；provider 里的字段原样透传，显式写的优先；
- 提示词缓存：cache 打开时按协议加缓存标记（Anthropic 给 system 和最后一条消息打 ephemeral 标记，
  OpenAI 系给 promptCacheKey），键默认按"地址 + 模型 + system 哈希"生成；
- 结构化输出：output 有值就挂上 AI SDK 的 output 参数，没值就不挂（不需要单独开关）。

configure 只做翻译，不发请求、不重试、不处理文字工具（那些在 ask 里）。
没有模块级可变状态：provider 实例每次调用现建，构造成本可以忽略，换 baseURL / apiKey 也立即生效。
*/

import type { LanguageModel, ModelMessage } from 'ai'
import type { AskRequest } from '../types.ts'

// configure 的产物：ask 直接展开交给 generateText / streamText，再补上 tools、signal 等运行期参数。
export interface Configured {
    model: LanguageModel
    system: string | undefined
    messages: ModelMessage[]
    maxOutputTokens?: number
    providerOptions?: Record<string, Record<string, any>>
    headers?: Record<string, string>
    output?: unknown
    extra: Record<string, unknown>   // provider 里其余的生成参数（temperature 等），原样透传
}

/*
configure：按文件头的规则把 request 翻译成 Configured。
model 是字符串但缺 baseURL 时抛 TypeError（说明要么给地址，要么直接传模型实例）。
*/
export function configure(request: AskRequest): Configured {
    throw new Error('TODO')
}
