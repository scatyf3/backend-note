---
title: 幂等与错误语义
---

# 幂等与错误语义

这一格解决的是「超时之后能不能放心重试」。超时意味着结果未知：请求可能没到，也可能执行了但响应丢了，所以重试不可避免，而重试安全的前提是幂等。实现手段有：选天然幂等的操作、唯一约束 + upsert、条件更新 / 版本号，以及通用的幂等 key（存下第一次的响应，原样返回给重试）。错误要分成可重试（超时、5xx、429）和不可重试（大多数 4xx）两类；重试要有退避、抖动和预算，并且只在一层做。

- **exactly-once = at-least-once 投递 + 幂等处理**；幂等 key 的抢占要靠唯一约束，不能「先查再插」。
- **LLMGateway 把 SDK 的 `max_retries` 设成 0**，由 router 统一负责重试，避免多层重试放大尾延迟；4xx 不 fallback。
- **AI 场景更需要幂等**：LLM 调用重复一次就多花一份钱、得到另一个答案；agent 有副作用的工具要用 `(conversation_id, tool_call_id)` 去重。

笔记：[幂等与错误语义](/backend/idempotency)

**延伸阅读**：[Stripe: Idempotent requests](https://docs.stripe.com/api/idempotent_requests)、[Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
