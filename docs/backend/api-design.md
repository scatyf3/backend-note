---
title: API 设计与序列化：REST、gRPC 与兼容性
status: draft
tags: [api, rest, grpc, protobuf, json, versioning]
difficulty: 3
order: 4
related: [/backend/auth, /backend/idempotency, /backend/streaming-sse-websocket, /ai/provider-api-structured-output]
stack: [api-design]
---

# {{ $frontmatter.title }}

## 一句话结论

API 是一份**契约**。设计目标有两个：==让调用方很难用错，让服务端能演进而不破坏老客户端==。REST 面向资源，复用 HTTP 的方法、状态码和缓存语义；gRPC 面向方法，用 Protobuf schema 换来强类型和高效的二进制编码；GraphQL 让客户端自己声明要什么字段。三者之外，真正决定 API 寿命的是**兼容性规则**：加字段可以，删字段和改语义不行；状态码和错误格式也是契约的一部分，因为客户端 SDK 会根据它们自动做决策，比如自动重试 429。

## 为什么：契约一旦发布就收不回来

服务端可以随时部署新版本，但客户端（移动端 App、第三方集成、别的团队的服务）的升级不受你控制。线上同时跑着好几个版本的客户端是常态。所以设计 API 时要回答三个问题：

1. **语义清楚**：调用方不读源码也知道这个接口做什么、会不会有副作用、失败了能不能重试。
2. **向后兼容**：新服务端要能处理老客户端的请求，老客户端要能读懂新服务端的响应。
3. **错误可处理**：调用方能根据错误码判断该重试、该改请求还是该报警。

## REST：把 HTTP 的语义用对

### 方法的语义

| 方法 | 安全（无副作用） | 幂等 | 典型用途 |
|---|---|---|---|
| GET / HEAD | 是 | 是 | 读取 |
| PUT | 否 | 是 | 整体替换（客户端知道资源 id） |
| DELETE | 否 | 是 | 删除（删两次的结果和删一次一样） |
| POST | 否 | **否** | 创建、触发动作 |
| PATCH | 否 | 不保证 | 部分更新 |

「幂等」说的是**服务端状态**：同一个请求执行多次，效果和执行一次相同，返回值可以不同（第二次 DELETE 可以返回 404）。这条语义决定了网关、客户端能不能自动重试，详见[幂等与错误语义](/stack/api-idempotency)。

### 状态码就是给机器看的错误分类

| 码 | 意思 | 调用方应该怎么做 |
|---|---|---|
| 200 / 201 / 204 | 成功 / 已创建 / 成功但没有响应体 | |
| 202 | 已接受，异步处理中 | 轮询或等回调 |
| 400 / 422 | 请求格式错误 / 格式对但语义不合法 | 改请求，**不要重试** |
| 401 | 没认证（缺少或无效的凭证） | 重新登录、刷新 token |
| 403 | 认证了，但没有权限 | 不要重试 |
| 404 | 不存在（也常用来隐藏「存在但你无权访问」） | |
| 409 / 412 | 状态冲突 / 前置条件（`If-Match`）不满足 | 重新读取再决定 |
| 413 | 请求体太大 | |
| 429 | 被限流，看 `Retry-After` | 退避后重试 |
| 5xx | 服务端出错 | 可以有限次重试 |

错误体建议用统一格式，比如 RFC 9457 的 Problem Details（`type`、`title`、`status`、`detail`），或者 OpenAI 风格的 `{"error": {"type", "code", "message"}}`。要点是**机器可读的错误码**和**给人看的描述**分开。

### 分页：offset 和 cursor

- **offset 分页**（`?offset=10000&limit=20`）：实现简单，能跳页；但数据库要扫过前一万行再丢掉，越往后越慢。翻页过程中有新数据插入的话，会出现重复或漏掉的条目。
- **cursor / keyset 分页**（`?after=<最后一条的排序键>`）：用 `WHERE (created_at, id) < (?, ?) ORDER BY ... LIMIT 20`，走索引，性能稳定，插入新数据也不会错位；代价是不能直接跳到第 N 页。

==面向无限滚动和大表，默认用 cursor 分页。== cursor 最好做成不透明的 base64 字符串，客户端只管原样传回，服务端可以随时改它的内部结构。

## gRPC：schema 先行

gRPC 基于 HTTP/2 和 Protobuf，用 `.proto` 文件定义服务和消息，再生成各种语言的客户端和服务端代码。

- **四种调用模式**：unary、server streaming、client streaming、双向 streaming。
- **deadline 传播**：客户端设置的截止时间会随调用链往下传，下游能知道「还剩多少时间」，超时就不必再算了。
- **代价**：浏览器不能直接调（要用 grpc-web 或网关转换），调试不如 JSON 直观，负载均衡需要 L7（HTTP/2 长连接的问题见[网络](/backend/network-tcp-http-tls)）。

### Protobuf 的兼容性规则

Protobuf 的线上格式只认**字段编号**，不认字段名：

1. **可以加新字段**（用新编号）：老代码读到不认识的字段会跳过（proto3 会保留未知字段）。
2. **不能复用编号**：删掉的字段要用 `reserved` 占住编号和名字，否则新字段会被老数据错误解析。
3. **不能改字段类型**（少数兼容的整型之间除外）。
4. 改字段名不影响二进制兼容，但会破坏 JSON 映射和生成的代码。

## GraphQL：客户端决定形状

客户端用一个查询声明需要哪些字段，一次请求拿全，适合前端聚合多个数据源。代价：

- **N+1 查询**：每个列表元素的子字段各触发一次查询，要用 DataLoader 做批量合并。
- **查询成本不可控**：深度嵌套的查询可能把后端打挂，要做深度和复杂度限制。
- **HTTP 缓存失效**：大多走 `POST /graphql`，CDN 缓存不了，要靠 persisted queries。

## 序列化格式

| 格式 | 优点 | 坑 |
|---|---|---|
| JSON | 人能读、无处不在 | 没有 schema；**数字精度** |
| Protobuf | 紧凑、快、有 schema | 要生成代码；人不能直接读 |
| Avro | schema 跟数据一起演进，配合 schema registry | 主要在 Kafka 等数据管道里用 |
| MessagePack | JSON 的二进制版，无 schema | 生态小 |

==JSON 的数字精度坑==：JSON 规范本身没有限制数字大小，但 JavaScript 的 `Number` 是 IEEE 754 双精度浮点，只能精确表示 $2^{53}$ 以内的整数。雪花算法这类 64 位 id 传到浏览器里，末几位会被悄悄改掉。Twitter API 因此同时返回 `id` 和 `id_str`。对外的 64 位 id **用字符串传**。

## 版本与演进

- **能不升版本就不升**：只加可选字段、不改语义，就是兼容的变更，不需要新版本。
- **必须破坏兼容时**：URL 版本（`/v1/`、`/v2/`）最直观，便于路由和监控；也可以用 header 或日期版本（Stripe 的做法：每个账号固定在一个 API 日期上，服务端维护版本之间的转换层）。
- **tolerant reader**：客户端忽略不认识的字段，服务端对客户端额外发来的字段宽容处理。但对**不可信的输入**要严格校验，这两点要按场景区分。
- **废弃要有流程**：发 `Deprecation` / `Sunset` header，监控旧版本的调用量，降到零再下线。

## 实战：DocPilot 和 LLMGateway 的接口取舍

**1. 选一个现成的协议，而不是自己发明。**

- DocPilot 的 `/chat` 不自己定义流式格式，而是实现 Vercel AI SDK 的 UI message stream 协议，前端的 `useChat` 直接就能消费（详见[流式接口](/stack/api-streaming)）。
- LLMGateway 对外是 **OpenAI 兼容接口**（`/v1/chat/completions`），内部所有后端也都用 OpenAI 格式的 dict，只有 Anthropic adapter 负责翻译。理由是：OpenAI 格式已经成了事实标准，兼容它就白拿了所有语言的 SDK 和工具链。DocPilot 只要改一个 `OPENAI_BASE_URL`，就能把全部流量切到网关上。

**2. 状态码是契约，会驱动客户端的自动行为。** LLMGateway 在月度预算耗尽时返回 **402 `insufficient_quota`**，而不是 429。`gateway/limits.py` 的注释写得很清楚：OpenAI SDK 会自动重试 429，返回 429 只会让客户端反复冲击一个注定失败的请求。==选状态码时要想清楚，下游的 SDK 拿到它会做什么。==

**3. 宽容和严格要分场景。** 同一个项目里，pydantic 的配置方向正好相反：

- `ChatRequest` 用 `extra="allow"`：前端 SDK 会发 `trigger`、`messageId` 等一堆字段，SDK 升级还可能加新字段，服务端只取自己需要的，避免前端升级导致 422。
- 工具参数（`SearchDocsArgs` 等）用 `extra="forbid"`：这些参数是 LLM 生成的，多出来的字段说明模型理解错了，要立刻报错，让模型自己修正。

**4. schema 和校验来自同一个定义。** FastAPI 用 pydantic 模型同时生成 OpenAPI 文档和做请求校验；DocPilot 的工具也用同一个 pydantic 模型生成给模型看的 JSON Schema，并校验模型返回的参数，两者不会对不上。

**5. 客户端生成 id。** `conversations.id` 是前端生成的字符串，服务端用 `INSERT ... ON CONFLICT DO NOTHING` 建会话，重复提交天然幂等，也不需要「先建会话再发消息」这一轮额外的请求。

**6. 一个接口服务三类调用方。** `/search` 本来是调试检索用的，eval 也通过它算 recall@5 和 MRR；`evals/run.py` 用 `httpx.ASGITransport` 在进程内调用同一个 FastAPI app。==eval 走的是生产代码路径，而不是一份平行的实现==，测出来的数字才可信。

## 追问

::: details PUT、PATCH、POST 有什么区别？
- **PUT**：用请求体整体替换某个 URI 上的资源，客户端知道资源 id，是幂等的。
- **PATCH**：部分更新，是否幂等取决于补丁的写法（「把 x 设为 5」幂等，「x 加 1」不幂等）。
- **POST**：创建资源（由服务端分配 id）或触发动作，不幂等。

要让 POST 能安全重试，就加幂等 key，或者让客户端生成 id。
:::

::: details 401 和 403 有什么区别？400 和 422 呢？
- **401**：没认证，凭证缺失、过期或无效，客户端应该重新登录或刷新 token。
- **403**：认证了，但没权限，重试没用。

有时为了不暴露资源是否存在，无权访问时会直接返回 404。

- **400**：请求格式错误（JSON 解析不了、缺少必填字段）。
- **422**：格式没问题，但语义不合法（比如上传的文件里提取不出文本，DocPilot 就返回 422）。
:::

::: details offset 分页和 cursor 分页怎么选？
offset 简单，能跳页，但深分页要扫描并丢弃大量的行，越翻越慢，翻页时有插入还会导致重复或漏条。cursor（keyset）分页用「上一页最后一条的排序键」作为条件走索引，性能稳定、不会错位，但不能跳页。后台管理、页数少的列表用 offset；feed、无限滚动、大表用 cursor。
:::

::: details 什么样的 API 变更会破坏兼容性？
**破坏性**：删字段、改字段名或类型、改字段语义、把可选参数变成必填、改错误码含义、收紧校验规则（以前接受的输入现在拒绝）。Protobuf 里复用字段编号也是破坏性的。

**兼容**：加可选字段、加新接口、放宽校验、加新的枚举值（前提是客户端能处理未知枚举值）。
:::

::: details REST 和 gRPC 怎么选？
- **对外公开的 API、浏览器直接调用、需要 HTTP 缓存**：用 REST + JSON，调试友好，生态最广。
- **内部服务之间、性能敏感、需要流式和强类型**：用 gRPC，Protobuf 编码小、代码生成省事、deadline 能沿调用链传播。

代价是浏览器支持差、需要 L7 负载均衡。很多公司是对外 REST、对内 gRPC，中间用网关转换。
:::

::: details 为什么 64 位 id 在 JSON 里要用字符串返回？
JavaScript 的 `Number` 是双精度浮点，只能精确表示 $2^{53}$（约 9×10^15）以内的整数。雪花 id 这类 64 位整数在浏览器里 `JSON.parse` 之后，末几位会被悄悄改变，而且不报错。所以对外接口里的 64 位 id 应该用字符串，Twitter 的 `id_str` 就是这么来的。
:::

::: details 为什么 LLMGateway 预算耗尽时返回 402 而不是 429？
429 的语义是「稍后重试就会好」，OpenAI SDK 会自动带退避重试 429。预算耗尽在这个月内不会自己恢复，返回 429 只会让所有客户端反复重试，白白增加负载和延迟。402 `insufficient_quota` 不在 SDK 的自动重试范围内，调用方能立刻看到真实的原因。这说明状态码不只是给人看的，它会驱动客户端的自动行为。
:::

## 参考

- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)（方法的安全性、幂等性和状态码）
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [Protocol Buffers: Updating A Message Type](https://protobuf.dev/programming-guides/proto3/#updating)
- [Google API Design Guide](https://cloud.google.com/apis/design)、[Stripe: APIs as infrastructure: future-proofing Stripe with versioning](https://stripe.com/blog/api-versioning)
- [gRPC: Deadlines](https://grpc.io/docs/guides/deadlines/)
- 实战代码：DocPilot `routes/documents.py`、`routes/chat.py`（`ChatRequest`）、`agent/tools.py`（`extra="forbid"`）、`evals/run.py`（`ASGITransport`）；LLMGateway `gateway/limits.py`（402 vs 429）
