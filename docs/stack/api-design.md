---
title: API 设计与序列化
---

# API 设计与序列化

这一格解决的是「怎么定义一份既好用、又能长期演进的接口契约」。REST 复用 HTTP 的方法、状态码和缓存语义；gRPC 用 Protobuf schema 换来强类型、二进制编码和流式；GraphQL 让客户端决定返回的形状。真正决定 API 寿命的是兼容性规则：加可选字段可以，删字段、改语义、复用 Protobuf 字段编号不行。代价是每个设计决策发布后都很难收回，因为线上一定同时跑着多个版本的客户端。

- **状态码会驱动客户端的自动行为**：LLMGateway 预算耗尽时回 402 而不是 429，因为 OpenAI SDK 会自动重试 429。
- **大表默认用 cursor 分页**；64 位 id 在 JSON 里用字符串传（JS 只能精确表示 $2^{53}$ 以内的整数）。
- **对可控的客户端宽容，对不可信的输入严格**：DocPilot 的 `ChatRequest` 用 `extra="allow"`，LLM 生成的工具参数用 `extra="forbid"`。

笔记：[API 设计与序列化](/backend/api-design)

**延伸阅读**：[Google API Design Guide](https://cloud.google.com/apis/design)、[RFC 9457: Problem Details](https://www.rfc-editor.org/rfc/rfc9457)
