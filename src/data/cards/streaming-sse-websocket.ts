import type { Card } from '@lib/flashcards'

const R = '/backend/streaming-sse-websocket'

export const cards: Card[] = [
  {
    id: 'stream-sse-vs-ws',
    deck: 'backend',
    topic: 'SSE / WebSocket',
    q: 'SSE 和 WebSocket 怎么选？为什么 LLM 的 token 流普遍用 SSE？',
    a: '- **SSE**：就是一个普通的 HTTP 响应（`text/event-stream`），单向推送，能直接复用现有的鉴权、LB、代理和 HTTP/2，浏览器内置重连（`Last-Event-ID`）。\n- **WebSocket**：全双工，要 Upgrade，连接有状态，重连和心跳都得自己做。\nLLM token 流**本质是单向的**（请求一次、持续接收），SSE 足够且对基础设施最友好。实时语音这种客户端也要持续上传的场景才需要 WebSocket / WebRTC。',
    ref: `${R}#三种方式对比`,
  },
  {
    id: 'stream-eventsource-limits',
    deck: 'backend',
    topic: 'SSE',
    q: '浏览器原生 `EventSource` 有什么限制？LLM 聊天应用通常怎么绕开？',
    a: '1. **只能发 GET**，没法 POST 一大段对话历史；\n2. **不能自定义请求头**，没法带 `Authorization`；\n3. HTTP/1.1 下每个域名最多 6 个连接，多开几个标签页就会占满。\n实践中用 **`fetch` + `ReadableStream`** 自己解析 SSE，Vercel AI SDK 的 `DefaultChatTransport` 就是这么做的。解析时要缓冲到**空行**再处理，因为网络分片可能在任意位置切断一行。',
    ref: `${R}#sse-的格式`,
  },
  {
    id: 'stream-error-after-200',
    deck: 'backend',
    topic: '错误处理',
    q: '流式响应已经返回 200，中途出错了怎么通知客户端？监控上要注意什么？',
    a: '状态码已经发出，没法再改，只能**在流里发一个约定好的错误事件**：DocPilot 的 `encoder.fail()` 先关闭打开的步骤，再发 `{"type":"error"}` 和 `[DONE]`；LLMGateway 发 OpenAI 格式的 `{"error":{...}}`。\n监控上：要单独统计「流中途失败」，**不能因为状态码是 200 就算成功**。LLMGateway 在内部把这种情况记为 502。',
    ref: `${R}#难点-1-http-200-已经发出后出错`,
  },
  {
    id: 'stream-fallback-first-byte',
    deck: 'backend',
    topic: 'fallback',
    q: '为什么 LLM 网关的流式请求只在首字节之前 fallback？代价是什么？',
    a: '客户端收到部分回答之后再换后端，会把**两次不同的生成拼成一个回答**。所以 LLMGateway 的 `_open_stream` 先等上游的**第一个 chunk** 到达（受 `timeout_s` 限制）才把流交给客户端：在这之前失败可以换下一个后端，之后失败只能在流里发 error 事件。\n**代价**：后端在流中途挂掉时不会被重试。',
    ref: `${R}#难点-1-http-200-已经发出后出错`,
  },
  {
    id: 'stream-trailing-info',
    deck: 'backend',
    topic: '协议设计',
    q: '为什么流式请求的成本、token 用量、引用没法放在响应头里？DocPilot 是怎么传的？',
    a: '**响应头在第一个字节之前就发出去了**，而 usage 要等最后一个 chunk、引用要等全文生成完再回数据库解析。\nDocPilot 把它们作为自定义事件放在**流的末尾**：`data-citations`、`data-trace`，然后才是 `finish` 和 `[DONE]`。LLMGateway 在流式 cache miss 时**不返回** `x-gateway-cost-usd` 头。',
    ref: `${R}#实战-1-docpilot-的流式协议`,
  },
  {
    id: 'stream-buffering',
    deck: 'backend',
    topic: '排障',
    q: 'SSE 流在线上「等全部生成完才一次性出现」，可能是哪些原因？',
    a: '都是中间某一层在**缓冲**：\n1. nginx 的 `proxy_buffering`：加 `X-Accel-Buffering: no` 响应头（DocPilot 的做法）；\n2. 响应被 **gzip / brotli 压缩**，压缩器会攒数据，SSE 不要压缩；\n3. CDN 或 serverless 平台不支持流式；\n4. 框架没有逐块 flush。\n排查：从客户端到应用逐层用 `curl -N` 直连测试。',
    ref: `${R}#实战-1-docpilot-的流式协议`,
  },
  {
    id: 'stream-disconnect',
    deck: 'backend',
    topic: '断开',
    q: '用户在 LLM 流式输出时关掉页面，服务端应该做哪几件事？LLMGateway 怎么保证断开也记账？',
    a: '1. **停止生成**：取消会沿着 `await` 传到上游调用，关闭连接，避免继续花钱。\n2. **照常记账**：LLMGateway 的 `relay()` 把计费、写缓存、记指标都放在 **`finally`** 里，断开时状态记为 **499**。\n3. 关键的清理操作要防住**二次取消**（anyio 的取消语义下，`finally` 里的 await 可能被再次取消，要用 shield）。\n4. 统计断开率，它能反映 TTFT 过长或回答过长。',
    ref: `${R}#难点-2-客户端中途断开`,
  },
  {
    id: 'stream-resume',
    deck: 'backend',
    topic: '续传',
    q: '想让用户刷新页面后接着看正在生成的回答，后端要怎么设计？',
    a: '把**生成**和**连接**解耦：\n1. 生成在**后台任务**里跑，不依赖某个 HTTP 连接的生命周期；\n2. 每个 token 带递增的事件 id，写进 **Redis Stream** 之类的缓冲；\n3. 客户端重连时带 `Last-Event-ID`，从断点补发，再继续实时推送；\n4. 生成结束后落库，缓冲设置过期时间。\n顺带解决重复提交：同一个消息 id 的第二个连接直接订阅已有的生成，**不会重复花钱**。',
    ref: `${R}#难点-2-客户端中途断开`,
  },
]
