---
title: 流式接口：SSE、WebSocket 与 LLM 流
status: draft
tags: [sse, websocket, streaming, llm]
difficulty: 3
order: 7
related: [/backend/network-tcp-http-tls, /backend/idempotency, /backend/concurrency-models, /ai/llm-latency-cost, /ai/llm-gateway]
stack: [api-streaming]
---

# {{ $frontmatter.title }}

## 一句话结论

服务端向客户端推数据有三种方式：**轮询 / 长轮询**、**SSE**（HTTP 上的单向事件流）、**WebSocket**（独立的全双工协议）。==LLM 的 token 流首选 SSE==：它就是一个普通的 HTTP 响应，能直接复用现有的鉴权、负载均衡和代理，而 token 流本来就是单向的。真正的难点不在协议本身，而在协议周边：代理缓冲、空闲超时、HTTP 200 已经发出后才出错怎么办、生成到一半客户端断开怎么办，以及那些「最后才知道」的信息（token 用量、成本、引用）该怎么传回去。

## 为什么需要流式

LLM decode 每秒几十个 token，一个 1000 token 的回答要 20 秒左右（见[延迟与成本模型](/stack/llm-latency-cost)）。不流式，用户就要对着空白屏幕等 20 秒；流式的话，用户感知的延迟是 TTFT，一秒左右就能开始读。agent 场景更需要流式：用户能实时看到「正在搜索」「读了哪几篇文档」，知道它没卡住。

## 三种方式对比

| | 轮询 / 长轮询 | SSE | WebSocket |
|---|---|---|---|
| 方向 | 客户端拉 | 服务端 → 客户端单向 | 双向 |
| 协议 | 普通 HTTP | 普通 HTTP，`text/event-stream` | `Upgrade` 之后切换到 WebSocket 帧协议 |
| 自动重连 | 不涉及 | 浏览器的 `EventSource` 内置，支持 `Last-Event-ID` | 要自己实现 |
| 基础设施兼容性 | 最好 | 好（但要处理代理缓冲） | LB、代理要支持 Upgrade 和长连接 |
| 典型用途 | 低频状态查询 | LLM token 流、通知、进度 | 协作编辑、游戏、实时语音 |

选择口诀：**单向推送用 SSE，真正需要双向低延迟交互时才用 WebSocket**。实时语音这种客户端也要持续上传音频的场景，才需要 WebSocket 或 WebRTC。

## SSE 的格式

响应头是 `Content-Type: text/event-stream`，响应体是一串**由空行分隔的事件**：

```
event: message
id: 42
data: {"type":"text-delta","delta":"Hello"}

: 这是一行注释，可以用作心跳

data: [DONE]

```

- `data:` 是载荷，可以有多行；`event:` 是事件类型；`id:` 用于断线续传；`retry:` 建议客户端的重连间隔。
- **以 `:` 开头的是注释**，客户端会忽略，常用来发心跳，防止空闲超时。
- **客户端要缓冲到空行再解析**：网络分片可能在任意位置切断一行。

浏览器原生的 `EventSource` 有两个限制：**只能发 GET**，**不能自定义请求头**（没法带 `Authorization`）。LLM 应用要 POST 一大段对话历史，所以实践中用 `fetch` + `ReadableStream` 自己解析 SSE，Vercel AI SDK 的 `DefaultChatTransport` 就是这样做的。另外，HTTP/1.1 下浏览器对同一域名最多开 6 个连接，多开几个 SSE 标签页就会把连接占满，HTTP/2 能解决这个问题。

## 实战 1：DocPilot 的流式协议

DocPilot 的 `/chat` 实现的是 Vercel AI SDK 的 **UI message stream** 协议（`api/src/docpilot/ui_stream.py`）。一轮回答的事件序列大致是：

```
start                         {messageId}
start-step
text-start / text-delta… / text-end     （每段文字有一个 id）
tool-input-available          {toolCallId, toolName, input, dynamic: true}
tool-output-available         {toolCallId, output}
finish-step
start-step                    （下一步 agent 循环）
…
data-citations                [解析后的引用]
data-trace                    {token、延迟、成本…}
finish                        {finishReason}
data: [DONE]
```

几个设计点：

1. **协议是有状态的，编码器单独实现**：每段文字必须被 `text-start` / `text-end` 包住，每个 agent 步骤必须被 `start-step` / `finish-step` 包住。`chat_stream.py` 的 `ChatStreamEncoder` 维护「当前有没有打开的文字段、有没有打开的步骤」，并且**不做任何 IO**，所以能直接写单元测试。
2. **工具标成 `dynamic: true`**：这些工具在服务端执行，前端事先不知道它们的定义。
3. **「最后才知道」的信息放在流的末尾**：引用要等全文生成完，再把 `[c:id]` 回数据库解析；token 用量和成本要等所有步骤结束才知道。它们作为自定义的 `data-*` 事件，在 `finish` 之前发出。==响应头在第一个字节之前就发出去了，所有生成结束后才确定的信息都只能放进流里==。LLMGateway 也一样：流式请求在 cache miss 时不返回 `x-gateway-cost-usd` 头，因为发响应头的时候成本还不知道。
4. **关掉代理缓冲**：响应头里有 `x-accel-buffering: no` 和 `cache-control: no-cache`，防止 nginx 或 Fly 的代理把流攒起来再一次性发送。gzip 压缩也会造成缓冲，SSE 响应不要压缩。

## 难点 1：HTTP 200 已经发出后出错

流开始之后，状态码早就是 200 了，后面再出错没法改状态码，只能**在流里表达错误**：

- DocPilot：`routes/chat.py` 的 `_encode` 捕获异常，调用 `encoder.fail()`，先关闭打开的步骤，再发一个 `{"type":"error","errorText":...}` 事件和 `[DONE]`。界面上能显示错误，而不是一个莫名其妙断掉的连接。
- LLMGateway：上游在流中途失败时，发一个 OpenAI 格式的 `{"error": {...}}` SSE 事件，状态记为 502。

还有一个相关的设计：**流式请求只在首字节之前 fallback**。LLMGateway 的 `router._open_stream` 会先等上游的第一个 chunk 到达（受 `timeout_s` 限制）才把流交给客户端。在那之前失败，可以安全地换下一个后端；在那之后失败，换后端会把两次不同的生成拼在一起，所以只能报错。代价是：后端在流中途挂掉时不会被重试。

## 难点 2：客户端中途断开

用户关掉页面时，服务端要回答三个问题：

1. **要不要停止生成**：继续生成是浪费钱。框架通常会取消响应生成器，取消会沿着 `await` 链一路传到 LLM 的流式调用上，上游连接随之关闭。
2. **已经花掉的 token 要不要记账**：要。LLMGateway 的 `relay()` 把计费、写缓存、记指标都放在 `finally` 里，客户端断开时，状态记为 **499**（借用 nginx 的「客户端关闭请求」状态码）。DocPilot 的写库在正常路径上，断开时不会执行（原因见[并发模型](/backend/concurrency-models)）。要注意：在 anyio 的取消语义下，`finally` 里的 `await` 有可能被再次取消，关键的写入要用 shield 保护。
3. **要不要允许续传**：如果希望用户刷新页面后能接着看，就要把**生成**和**连接**解耦：生成在后台任务里跑，token 写进 Redis Stream 之类的缓冲；连接只是一个订阅者，带着 `Last-Event-ID` 重连，从断点继续读。这样也顺带解决了「重复提交」的问题：同一个消息 id 的第二个连接直接订阅已有的生成过程（见[幂等](/backend/idempotency)、[长任务](/stack/ag-durable)）。

## 难点 3：长连接的基础设施问题

- **空闲超时**：LB 和代理在一段时间没有数据时会断开连接（AWS ALB 默认 60 s）。推理模型 thinking 时可能长时间没有可见输出，要定期发 `: ping` 注释作为心跳。
- **连接数**：每个进行中的流占一个连接和一个协程。容量规划要按「并发流数」而不是 QPS 来算：1000 个用户各自在看一个 20 秒的回答，就是 1000 个并发连接。
- **背压**：客户端读得慢时，服务端的生成器在 `yield` 处等待发送完成（ASGI 的 `send` 会等待），不会无限堆积内存。但如果中间有一层无界的缓冲，就会失去这个保护。
- **WebSocket 额外的问题**：连接是有状态的，扩缩容和发布时要优雅地迁移连接；LB 要支持 Upgrade 和长时间的 idle；断线重连、消息顺序、心跳都要自己实现。

## 实战 2：网关怎么转发和回放流

LLMGateway 在 SSE 之上还处理了几件事：

- **usage 只在最后一个 chunk 里**：OpenAI 协议下，流式请求要带 `stream_options.include_usage` 才会在末尾多发一个只有 usage 的 chunk。网关为了计费，**总是**向上游要 usage；如果客户端自己没要，就把这个 chunk 过滤掉，不让客户端看到协议之外的数据。
- **TTFT 在网关里测**：收到第一个**有内容**的 chunk 时记录 TTFT 指标，而不是收到第一个 chunk 的时候（第一个 chunk 可能只有 role 字段）。
- **缓存命中回放成 SSE**：exact cache 的 key 不包含 `stream` 字段，流式请求和非流式请求共享缓存。流式请求命中缓存时，把存下来的完整响应重新切成 SSE chunk 发出去，客户端感觉不到区别。

## 追问

::: details SSE 和 WebSocket 怎么选？为什么 LLM API 普遍用 SSE？
SSE 是普通的 HTTP 响应，单向推送，能直接复用现有的鉴权、负载均衡、代理和 HTTP/2，浏览器还内置重连。WebSocket 是全双工，但需要 Upgrade，连接有状态，重连和心跳都要自己做。

LLM 的 token 流本质上是单向的（请求一次，持续接收），所以 SSE 足够，而且对基础设施最友好。实时语音这种需要客户端持续上传的场景，才需要 WebSocket 或 WebRTC。
:::

::: details 流式响应已经返回 200 了，中途出错怎么告诉客户端？
状态码已经发出，没法再改，只能在流里发一个约定好的错误事件。DocPilot 发 `{"type":"error"}` 再加 `[DONE]`，LLMGateway 发 OpenAI 格式的 `{"error":{...}}`。客户端要能识别这个事件，并把已经显示的部分内容标记为不完整。服务端日志和指标里，要单独记录「流中途失败」，不能因为状态码是 200 就算成成功。
:::

::: details 为什么流式请求的成本没法放在响应头里？
响应头在第一个字节之前就发出去了，而 token 用量要等生成结束、拿到最后一个 usage chunk 之后才知道。所以 LLMGateway 在流式 miss 时不返回成本头，DocPilot 把成本放在流末尾的 `data-trace` 事件里。通用的规律是：生成结束后才确定的信息（usage、引用、trace）都要作为流里的最后几个事件发送，或者让客户端事后单独查询。
:::

::: details 线上 SSE 流「要等全部生成完才一次性出现」，可能是哪些原因？
都是中间某一层在缓冲：
1. nginx 的 `proxy_buffering`：加 `X-Accel-Buffering: no` 响应头，或者在配置里关掉；
2. 响应被 gzip / brotli 压缩，压缩器会攒数据，SSE 响应要关掉压缩；
3. 某些 CDN 或 serverless 平台不支持流式，会缓冲整个响应；
4. 应用框架本身没有逐块 flush，比如用了非流式的响应类型。

排查办法：从客户端到应用逐层用 `curl -N` 直连测试。
:::

::: details 用户刷新页面后，想接着看正在生成的回答，后端要怎么设计？
把生成和连接解耦：
1. 生成在后台任务里执行，不依赖某一个 HTTP 连接的生命周期；
2. 每个 token 带递增的事件 id，写进 Redis Stream 之类的缓冲；
3. 客户端重连时带上 `Last-Event-ID`，服务端从这个位置之后开始补发，然后继续实时推送；
4. 生成结束后把完整结果落库，缓冲设置过期时间。

这样同一条消息的重复请求也能直接订阅已有的生成过程，不会重复花钱。
:::

::: details 客户端断开连接后，服务端应该做什么？
1. 停止生成：取消会沿着 `await` 传到上游的 LLM 调用，关闭连接，避免继续花钱（除非设计成支持续传、要在后台继续跑）；
2. 照常记账：已经花掉的 token 要计入成本。LLMGateway 在 `finally` 里计费，并把状态记为 499；
3. 关键的清理操作要防住二次取消（用 shield）；
4. 指标里单独统计断开率，它能反映 TTFT 太长或者回答太长的问题。
:::

## 参考

- [WHATWG HTML Living Standard: Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [RFC 6455: The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455)
- [Vercel AI SDK: Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
- [OpenAI API: Streaming（`stream_options.include_usage`）](https://platform.openai.com/docs/api-reference/chat/create#chat-create-stream_options)
- [nginx: proxy_buffering 与 X-Accel-Buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)
- 实战代码：DocPilot `api/src/docpilot/ui_stream.py`、`chat_stream.py`、`routes/chat.py`；LLMGateway `gateway/router.py`（`_open_stream`）、`gateway/pipeline.py`（`_stream_miss`）
