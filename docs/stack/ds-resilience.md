---
title: 限流、熔断与重试
---

# 限流、熔断与重试

依赖一定会出故障，韧性设计的目标是限制爆炸半径。慢比挂更危险：慢依赖让每个请求长时间占用资源，耗尽线程池和连接池，连不相关的请求也被拖慢。对应的手段有：每次调用都有超时并传播 deadline；重试只对可重试错误、加退避和预算、只在一层做；熔断器（CLOSED → OPEN → HALF-OPEN）在依赖持续失败时快速失败；限流用令牌桶，分布式场景下检查和扣减要原子；隔离舱给不同依赖独立的资源池；过载时主动拒绝，可选步骤失败就降级。

- **LLMGateway 有 fallback 但没有熔断**：主后端卡住时，每个请求都要先等满 60 秒才切换。
- **限流 Lua 用的是副本传入的时间**，改用 Redis `TIME` 能避开副本之间的时钟偏差。
- **DocPilot 的 rerank 失败会让整个检索失败**，应该退回到 RRF 的顺序。

笔记：[限流、熔断、超时与降级](/backend/rate-limit-circuit-breaker)

**延伸阅读**：[Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)、[Stripe: Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters)
