import type { Card } from '@lib/flashcards'

const R = '/ai/provider-api-structured-output'

export const cards: Card[] = [
  {
    id: 'papi-openai-vs-anthropic',
    deck: 'ai',
    topic: 'API 格式',
    q: 'OpenAI Chat Completions 和 Anthropic Messages 在 tool calling 上有哪些关键差异？',
    a: '1. **参数**：OpenAI 的 `function.arguments` 是 JSON **字符串**（可能解析失败）；Anthropic 的 `tool_use.input` 是**对象**。\n2. **结果回传**：OpenAI 每个结果一条 `role: tool` 消息；Anthropic 同一轮的所有结果放进**一条** user 消息，每个是一个 `tool_result` 块。\n3. **system prompt**：OpenAI 是一条消息，Anthropic 是顶层字段。\n4. **停止原因**：`tool_calls` / `length` / `content_filter` 对应 `tool_use` / `max_tokens` / `refusal`。\n5. Anthropic 的 **thinking 块**要原样放回历史。',
    ref: `${R}#两大格式对比`,
  },
  {
    id: 'papi-native-format',
    deck: 'ai',
    topic: '抽象',
    q: 'DocPilot 的 LLMProvider 接口让每家用自己的原生格式保存对话，agent 循环从不碰消息列表。为什么不统一转成一种通用格式？',
    a: '转成通用格式再转回来是**有损的**：Anthropic 的 thinking 块带**签名**，必须一字不改地放回下一轮请求；各家还有独有的字段和块类型。\n做法：provider 只对外暴露中立的 `TextDelta`（流式文本）、`TurnResult`（文本、tool calls、停止原因、token 数）和 `add_tool_results`（Anthropic 一条消息，OpenAI N 条）。新增一家只写 adapter，循环不变；`fake_provider` 实现同一接口，测试不需要 key。',
    ref: `${R}#实战-1-docpilot-的-provider-接口`,
  },
  {
    id: 'papi-stream-tool-fragments',
    deck: 'ai',
    topic: '流式',
    q: 'OpenAI 流式响应里，tool call 是怎么到达的？客户端要怎么拼？对接「OpenAI 兼容」服务时有什么坑？',
    a: '每个 chunk 带 `delta.tool_calls[{index, id?, function{name?, arguments?}}]`。要**按 `index` 累积**：`id` 和 `name` 通常只在第一个碎片里出现，`arguments` 是字符串碎片，全部拼起来后再解析 JSON。\n坑：有的兼容服务器发出了 tool call，`finish_reason` 却报 `stop`。DocPilot 的处理是：有 tool call 且停止原因为 stop 时，按 `tool_use` 处理。',
    ref: `${R}#流式的差异-tool-call-是一块一块到的`,
  },
  {
    id: 'papi-gateway-gaps',
    deck: 'ai',
    topic: '网关翻译',
    q: 'LLMGateway 把 OpenAI 请求翻译成 Anthropic 时，`tool_choice: "required"` 和 assistant prefill 分别怎么处理？背后的原则是什么？',
    a: '- **`tool_choice: required` / 指定函数**：对应 Anthropic 的 `any` / `tool`，当前的 Claude 5.5 模型会回 400，所以**降级成 `auto` 并打告警**。需要保证调用工具的调用方，要在 prompt 里要求，并自己检查返回。\n- **最后一条是 assistant 的 prefill**：会改变语义，**直接返回清楚的 400**。\n原则：能安全降级的降级并留日志，会改变语义的明确报错，**不要静默改变语义**，所有缺口都写进文档。',
    ref: `${R}#实战-2-网关的格式翻译`,
  },
  {
    id: 'papi-structured-levels',
    deck: 'ai',
    topic: '结构化输出',
    q: '结构化输出的三个级别是什么？各自保证到什么程度？',
    a: '1. **prompt 约束**（「只输出 JSON」+ 解析 + 失败重试）：什么都不保证，可能夹带解释文字或被截断。\n2. **JSON mode**：保证**语法**是合法 JSON，结构随意。\n3. **schema 约束解码**（OpenAI `strict: true`，Anthropic `output_config.format`）：语法合法并且**符合 schema**。\n第三级也只管**形状**，内容是否正确仍要用 pydantic 和业务规则校验。',
    ref: `${R}#结构化输出-三个级别`,
  },
  {
    id: 'papi-constrained-decoding',
    deck: 'ai',
    topic: '结构化输出',
    q: '约束解码（constrained decoding）是怎么保证输出符合 JSON Schema 的？有哪些限制？',
    a: '**原理**：把 schema 编译成有限状态机或文法，每生成一个 token 之前，算出当前合法的下一个 token 集合，把其他 token 的 logits 设为 $-\\infty$ 再采样，模型在物理上就输出不了不合法的结构（Outlines、XGrammar）。\n**限制**：1. schema 有子集要求（通常要 `additionalProperties: false`、字段全部 required）；2. 新 schema 首次使用有编译延迟；3. 碰到 `max_tokens` 或拒答时仍然得到不完整的输出；4. 内容正确性不保证。',
    ref: `${R}#约束解码的原理`,
  },
  {
    id: 'papi-check-stop-before-parse',
    deck: 'ai',
    topic: '结构化输出',
    q: '已经用了 schema 约束的结构化输出，为什么 DocPilot 的 judge 在解析 JSON 之前还要检查 stop_reason？',
    a: '约束解码只管「每一步选合法的 token」，管不了**生成被中途打断**：\n- `max_tokens`：输出到一半被截断，得到**半截 JSON**；\n- `refusal`：模型拒答，可能根本没有按 schema 输出。\n所以 judge 遇到这两种 stop_reason 直接抛错，不去解析。这条规则同样适用于 tool call：被 `max_tokens` 截断的 tool call 不能执行。',
    ref: `${R}#约束解码的原理`,
  },
  {
    id: 'papi-usage-cache',
    deck: 'ai',
    topic: 'usage',
    q: '把 Anthropic 的 usage 翻译成 OpenAI 格式时，prompt_tokens 应该怎么算？为什么？',
    a: 'Anthropic 把输入拆成三部分分别报告：`input_tokens`（未命中缓存的部分）、`cache_creation_input_tokens`（写入缓存）、`cache_read_input_tokens`（从缓存读取）。\nOpenAI 格式的 `prompt_tokens` 表示**全部输入**，所以 LLMGateway 计算 prompt = input + cache 写入 + cache 读取。\n只取 `input_tokens` 的话，命中缓存的请求会显示成输入很少，**限流和成本统计都会偏低**。（计费时 LLMGateway 把 cache 读取也按全价算，是一个轻微的高估。）',
    ref: `${R}#实战-2-网关的格式翻译`,
  },
]
