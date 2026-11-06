---
title: 流式接口
---

# 流式接口

这一格解决的是「怎么把一个持续几十秒的输出边生成边推给客户端」。SSE 是普通 HTTP 上的单向事件流，能复用现有的鉴权、负载均衡和代理，是 LLM token 流的首选；WebSocket 是全双工协议，只在真正需要双向低延迟交互时才用。难点不在协议，而在周边：代理缓冲和空闲超时、200 已经发出后怎么报错、客户端断开时要不要停止生成和记账，以及 usage、引用这种最后才知道的信息怎么传回去。

- **最后才确定的信息放进流的末尾**：DocPilot 在 `finish` 之前发 `data-citations`、`data-trace`；LLMGateway 流式 miss 时不返回成本头。
- **流式请求只在首字节之前 fallback**，之后的失败在流里发 error 事件。
- **断开也要记账**：LLMGateway 在 `finally` 里计费，状态记为 499；想支持续传，就把生成和连接解耦。

笔记：[流式接口：SSE、WebSocket 与 LLM 流](/backend/streaming-sse-websocket)

**延伸阅读**：[Server-sent events 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html)、[Vercel AI SDK: Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
