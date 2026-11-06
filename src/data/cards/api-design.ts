import type { Card } from '@lib/flashcards'

const R = '/backend/api-design'

export const cards: Card[] = [
  {
    id: 'api-method-semantics',
    deck: 'backend',
    topic: 'REST',
    q: 'GET、PUT、DELETE、POST、PATCH 哪些是安全的，哪些是幂等的？「幂等」具体指什么？',
    a: '- **安全且幂等**：GET、HEAD。\n- **幂等但不安全**：PUT（整体替换）、DELETE。\n- **都不是**：POST；PATCH 不保证幂等（「设为 5」幂等，「加 1」不幂等）。\n**幂等**指的是**服务端状态**：执行多次和执行一次的效果相同。返回值可以不同，比如第二次 DELETE 返回 404。这条语义决定了网关和客户端能不能自动重试。',
    ref: `${R}#方法的语义`,
  },
  {
    id: 'api-401-403-400-422',
    deck: 'backend',
    topic: '状态码',
    q: '401 和 403 的区别？400 和 422 的区别？各自调用方该怎么做？',
    a: '- **401**：没认证，凭证缺失、过期或无效 → 重新登录或刷新 token。\n- **403**：认证了但没权限 → 重试没用。（为了不暴露资源是否存在，有时直接回 404。）\n- **400**：请求格式错（JSON 解析不了、缺字段）。\n- **422**：格式对，但语义不合法，比如 DocPilot 上传的文件里提取不出文本。\n400 / 422 都应该**改请求，不要重试**。',
    ref: `${R}#状态码就是给机器看的错误分类`,
  },
  {
    id: 'api-402-not-429',
    deck: 'backend',
    topic: '状态码',
    q: 'LLMGateway 在 key 的月度预算耗尽时返回 402 而不是 429。为什么？',
    a: '429 的语义是「稍后重试就会好」，**OpenAI SDK 会自动带退避重试 429**。预算耗尽在这个月内不会恢复，返回 429 只会让客户端反复冲击一个注定失败的请求。\n402 `insufficient_quota` 不在自动重试范围内，调用方能立刻看到真实原因。\n教训：**状态码是契约的一部分，会驱动下游 SDK 的自动行为**。',
    ref: `${R}#实战-docpilot-和-llmgateway-的接口取舍`,
  },
  {
    id: 'api-cursor-pagination',
    deck: 'backend',
    topic: '分页',
    q: 'offset 分页有哪两个问题？cursor（keyset）分页怎么解决，又付出什么代价？',
    a: '**offset 的问题**：1. 深分页时数据库要扫描并丢弃前面所有的行，越往后越慢；2. 翻页期间有新数据插入，会出现重复或漏条。\n**cursor**：用上一页最后一条的排序键做条件，比如 `WHERE (created_at, id) < (?, ?) ORDER BY ... LIMIT 20`，走索引，性能稳定，插入也不会错位。\n**代价**：不能直接跳到第 N 页。cursor 最好做成不透明字符串，服务端可以随时改它的内部结构。',
    ref: `${R}#分页-offset-和-cursor`,
  },
  {
    id: 'api-protobuf-compat',
    deck: 'backend',
    topic: 'Protobuf',
    q: 'Protobuf 的哪些修改是兼容的，哪些会破坏兼容性？为什么删掉的字段要标 reserved？',
    a: '线上格式只认**字段编号**。\n- **兼容**：用新编号加字段（老代码会跳过未知字段）；改字段名（不影响二进制，但会影响 JSON 映射和生成的代码）。\n- **破坏**：改字段类型、**复用已删除字段的编号**。\n删掉的字段要用 `reserved` 占住编号和名字，否则以后有人用这个编号加了新字段，老数据里的旧值会被**错误解析**成新字段。',
    ref: `${R}#protobuf-的兼容性规则`,
  },
  {
    id: 'api-int64-json',
    deck: 'backend',
    topic: '序列化',
    q: '为什么对外 API 里的 64 位 id 应该用字符串而不是数字返回？',
    a: 'JavaScript 的 `Number` 是 IEEE 754 双精度浮点，只能精确表示 $2^{53}$（约 $9 \\times 10^{15}$）以内的整数。雪花 id 这类 64 位整数在浏览器里 `JSON.parse` 后，**末几位会被悄悄改掉，而且不报错**。\n所以 Twitter API 同时返回 `id` 和 `id_str`。对外的 64 位 id 用字符串传。',
    ref: `${R}#序列化格式`,
  },
  {
    id: 'api-tolerant-vs-strict',
    deck: 'backend',
    topic: '校验',
    q: 'DocPilot 里 `ChatRequest` 用 pydantic 的 `extra="allow"`，工具参数却用 `extra="forbid"`。为什么方向相反？',
    a: '- **`ChatRequest`**：调用方是前端 SDK（`DefaultChatTransport`），会发 `trigger`、`messageId` 等一堆字段，升级还可能加新字段。服务端只取自己需要的（**tolerant reader**），避免前端一升级就 422。\n- **工具参数**：是 **LLM 生成的**，多出来的字段说明模型理解错了，要立刻报错，把错误回传给模型让它自己修正。\n原则：对版本不受你控制、但可信的客户端宽容；对不可信的输入严格。',
    ref: `${R}#实战-docpilot-和-llmgateway-的接口取舍`,
  },
  {
    id: 'api-adopt-standard',
    deck: 'backend',
    topic: '协议选择',
    q: 'LLMGateway 对外提供 OpenAI 兼容接口，DocPilot 的 `/chat` 实现 Vercel AI SDK 的流式协议。「采用现成协议」换来了什么？',
    a: '1. **白拿生态**：任何语言的 OpenAI SDK 都能直接调网关；DocPilot 只改一个 `OPENAI_BASE_URL` 就把全部流量切到网关。前端 `useChat` 直接消费 `/chat` 的流，不用写解析代码。\n2. **内部统一成一种格式**：网关所有后端都用 OpenAI 格式的 dict，缓存、计费、流式代码只认一种 schema，只有 Anthropic adapter 负责翻译。\n代价：要跟着上游协议的版本走，碰到协议表达不了的特性（比如 thinking）只能丢弃或扩展。',
    ref: `${R}#实战-docpilot-和-llmgateway-的接口取舍`,
  },
]
