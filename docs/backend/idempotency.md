---
title: 幂等与错误语义：重试为什么必须安全
status: draft
tags: [idempotency, retry, backoff, exactly-once]
difficulty: 3
order: 6
related: [/backend/api-design, /backend/streaming-sse-websocket, /backend/rate-limit-circuit-breaker, /backend/outbox-event-driven, /ai/sampling-nondeterminism]
stack: [api-idempotency]
---

# {{ $frontmatter.title }}

## 一句话结论

分布式系统里，请求超时之后，调用方**不知道它到底执行了没有**，所以重试不可避免；==重试安全的前提是操作幂等==。实现幂等有几种办法：选天然幂等的操作（set 而不是 incr）、用幂等 key 记住结果、靠唯一约束和 upsert、用条件更新或版本号。错误语义要做的事是把失败分成「可重试」和「不可重试」两类，重试本身也要有退避、抖动和预算，否则会把一次小故障放大成雪崩。所谓「exactly-once」，工程上都是 **at-least-once 投递 + 幂等处理** 拼出来的。

## 为什么：超时等于「结果未知」

客户端发出请求后，可能发生三种情况：

1. 请求没到服务端（网络丢包）；
2. 服务端执行了，但响应在回来的路上丢了；
3. 服务端还在执行，只是比超时时间慢。

在客户端看来，三种情况**完全一样**，都是超时。如果不重试，情况 1 会丢请求；如果重试，情况 2、3 会重复执行。这是两将军问题在工程里的直接体现：通过不可靠的信道，没法让双方对「已执行」达成确定的共识。

所以唯一的出路是：==让重复执行变得无害==。这就是幂等。

## 实现幂等的几种办法

### 1. 选天然幂等的操作

- `SET balance = 100` 是幂等的，`SET balance = balance + 10` 不是。
- `PUT /users/42`（整体替换）、`DELETE /users/42` 是幂等的。
- 设计 API 时，尽量把「增量」改成「目标状态」，比如「把订单状态设为 paid」，而不是「推进订单状态」。

### 2. 唯一约束 + upsert

让数据库帮你去重：

```sql
INSERT INTO conversations (id) VALUES ($1) ON CONFLICT DO NOTHING;
```

DocPilot 的 `store.save_turn` 就是这样建会话的：会话 id 是前端生成的，同一个 id 重复插入是无害的。前提是 **id 由客户端生成**。如果是服务端用自增 id，每次重试都会建一条新记录。

### 3. 条件更新与乐观锁

```sql
UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending';
-- 影响 0 行：说明已经处理过了（或者状态不对）
UPDATE docs SET body = $2, version = version + 1 WHERE id = $1 AND version = $3;
```

状态机的转换带上「从哪个状态来」的条件，第二次执行自然就不生效。HTTP 层的对应物是 `ETag` + `If-Match`，条件不满足时返回 412。

### 4. 幂等 key：通用方案

对于本身不幂等的操作（扣款、发消息、调用 LLM），让客户端为每个**逻辑操作**生成一个唯一 key，放在请求头里（比如 Stripe 的 `Idempotency-Key`，IETF 也有对应的草案）。服务端的处理流程：

```
收到请求(key, body)：
  记录 = 查 key
  如果没有：
      插入 (key, 请求体哈希, status=processing)   ← 靠唯一约束抢占
      执行业务
      更新为 (status=done, 响应)
      返回响应
  如果 status=done：
      请求体哈希不一致 → 422（同一个 key 被用于不同的请求）
      否则 → 原样返回存下来的响应
  如果 status=processing：
      → 409，或者等待它完成
```

几个细节：

- **抢占要原子**：用唯一约束插入，不要「先查再插」，否则两个并发的重复请求会同时通过检查。
- **key 要按用户隔离**，并设置过期时间（Stripe 是 24 小时）。
- **存的是响应，不只是「处理过了」**：重试的客户端需要拿到和第一次一样的结果。
- **失败要区分**：业务失败（余额不足）也要记下来并原样返回；服务端在执行中途崩溃的，要能识别 `processing` 状态超时，并允许重新执行，这要求业务操作本身也能安全重入。

### 5. 消息消费去重

消息队列一般提供 at-least-once 投递，同一条消息可能来两次。消费者维护一张「已处理消息 id」表，**和业务写入放在同一个事务里**，见 [Outbox 与事件驱动](/stack/mq-outbox)。

## 错误语义：哪些能重试

| 错误 | 能否重试 | 原因 |
|---|---|---|
| 连接失败、超时 | 可以（前提是幂等） | 可能没执行，也可能执行了 |
| 5xx | 可以，有限次 | 服务端临时故障 |
| 429 | 可以，按 `Retry-After` | 限流，稍后会恢复 |
| 408 | 可以 | 请求超时 |
| 400 / 401 / 403 / 404 / 422 | **不可以** | 请求本身有问题，重试结果一样 |

LLMGateway 的 `gateway/errors.py` 把这个分类写成了代码：`is_retryable_status` 对 408、409、429 和 5xx 返回 true，router 只对可重试的错误 fallback 到下一个后端。原因写在 `BackendError` 的注释里：大多数 4xx 说明请求本身有问题，==换一个供应商也修不好，fallback 只会掩盖 bug，还白白增加延迟==。

### 退避、抖动和重试预算

- **指数退避**：第 n 次重试等 $base \times 2^n$，给下游恢复的时间。
- **抖动（jitter）**：在等待时间上加随机量（full jitter：在 $[0, base \times 2^n]$ 里随机取）。否则一大批客户端在同一时刻失败、又在同一时刻重试，形成一波波的流量尖峰（thundering herd）。
- **重试预算**：限制重试请求占总请求的比例（比如不超过 10%）。下游已经挂了的时候，重试只会雪上加霜，这时应该交给熔断器（见[限流、熔断与重试](/stack/ds-resilience)）。

### 重试放大：只在一层重试

调用链有 3 层，每层都重试 3 次，最底层的服务最坏会收到 $3^3 = 27$ 倍的流量。LLMGateway 的处理是：Anthropic SDK 的 `max_retries` 设为 0（`backends/anthropic.py`），注释写的是 router 负责重试和 fallback，叠加的 SDK 重试会在 fallback 发生之前，悄悄地把尾延迟放大好几倍。==重试应该只发生在一层，通常是离用户最近、且最了解业务语义的那一层。==

## AI 场景：幂等变得更重要，也更难

### LLM 调用贵，而且每次结果不同

传统接口重复执行一次，可能只是多写一行日志；LLM 接口重复执行一次，就是再花一份钱，而且得到一个**不同的**答案（见[采样与非确定性](/ai/sampling-nondeterminism)）。

DocPilot 的 `/chat` 目前没有幂等 key：前端因为网络抖动重发一次请求，服务端会再跑一遍完整的 agent 循环，重新扣一次 token 费用，还会在 `messages` 表里存下两条不同的回答。改进思路是用前端 AI SDK 已经带着的消息 id（`ChatRequest` 里 `extra="allow"` 会接收这些字段）作为幂等 key：

- 已完成的，直接返回存下来的答案；
- 还在生成中的，让新连接接上同一个生成过程（见[流式接口](/stack/api-streaming)里的断线续传），或者返回 409。

### agent 的工具调用要幂等

agent 会重试：模型可能对同一件事调用两次工具，agent 循环的某一步失败后也可能整步重跑。DocPilot 的 `create_page` 每调用一次就新建一篇文档，模型重复调用就会生成两篇一样的页面。有副作用的工具应该：

- 接受一个由调用上下文派生的幂等 key，比如 `(conversation_id, tool_call_id)`；
- 或者按内容去重，比如同一个会话里标题和内容哈希都相同，就返回已有文档的 id。

### 部署脚本也要幂等

DocPilot 的 `schema.sql` 全部用 `CREATE ... IF NOT EXISTS`，`docpilot db init` 在每次部署时都会跑（Fly 的 release command）。部署可能重试，也可能多个实例同时启动，DDL 必须能重复执行。`init_schema` 还有一个保护：`reset=True` 时拒绝删除 `public` schema，只允许删除 eval 用的独立 schema。

## 追问

::: details 什么是幂等？为什么分布式系统里重试必须配合幂等？
幂等：同一个操作执行多次和执行一次，对服务端状态的效果相同。

超时之后，客户端无法区分「请求没到」「执行了但响应丢了」「还在执行」这三种情况。不重试会丢请求，重试又可能重复执行，只有让重复执行变得无害，重试才是安全的。
:::

::: details 幂等 key 怎么实现？两个重复请求同时到达怎么办？
客户端为每个逻辑操作生成唯一 key 放在请求头里。服务端用**唯一约束插入**一条 `(key, 请求体哈希, processing)` 记录来抢占，抢到的执行业务，完成后存下响应；之后的重复请求直接返回存下来的响应。

两个请求同时到达时，只有一个能插入成功，另一个看到 `processing`，返回 409 或者等待。注意不要「先查再插」，那样会有竞态。同一个 key 配上不同的请求体要返回 422。
:::

::: details exactly-once 真的存在吗？
在投递层面，不可靠的网络上做不到严格的 exactly-once。工程上的 exactly-once 指的是**效果上**只执行一次：用 at-least-once 投递保证不丢，再用幂等处理保证重复无害。比如消费者把「消息 id 已处理」和业务写入放在同一个事务里提交。Kafka 的事务 / EOS 也是在这个思路上，把消费位点和输出放进同一个事务里。
:::

::: details 哪些错误应该重试？为什么 4xx 一般不重试？
连接失败、超时、5xx、429（按 `Retry-After`）、408 可以重试，前提是操作幂等。400 / 401 / 403 / 404 / 422 不应该重试：请求本身有问题，重发结果一样。

LLMGateway 的 router 只对可重试的错误 fallback 到别的供应商，因为一个格式错误的请求换哪家都会失败，fallback 只会掩盖 bug，还增加延迟。
:::

::: details 为什么重试要加抖动（jitter）？
一个依赖服务短暂故障时，所有客户端几乎在同一时刻失败。如果用固定的退避时间，它们又会在同一时刻重试，形成周期性的流量尖峰，让服务刚恢复就又被打垮（thundering herd）。加随机抖动把重试打散到一个时间窗口里。AWS 的分析表明，full jitter 在总完成时间和服务端负载上都表现最好。
:::

::: details 什么是重试放大？怎么避免？
调用链的每一层都各自重试，最底层的流量会被指数级放大：3 层 × 每层 3 次 = 27 倍。下游已经过载时，这会直接导致雪崩。

避免办法：
1. 只在一层重试（通常是最外层或者网关），其他层关掉，LLMGateway 就把 SDK 的 `max_retries` 设成了 0；
2. 设置重试预算；
3. 配合熔断器，下游持续失败时直接快速失败；
4. 把 deadline 往下传，超过截止时间就不要再重试。
:::

::: details 为什么 agent 的工具调用需要幂等？举个例子。
agent 会重复执行：模型可能对同一件事调用两次工具，循环里某一步失败后也可能整步重跑。DocPilot 的 `create_page` 每次调用都新建一篇文档，被调两次就会出现两篇一样的页面；如果工具是「发邮件」或者「下单」，后果更严重。有副作用的工具应该用 `(conversation_id, tool_call_id)` 这类上下文派生的幂等 key，或者按内容哈希去重。
:::

## 参考

- [Stripe: Idempotent requests](https://docs.stripe.com/api/idempotent_requests)、Brandur Leach, [Implementing Stripe-like Idempotency Keys in Postgres](https://brandur.org/idempotency-keys)
- [IETF draft: The Idempotency-Key HTTP Header Field](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
- Marc Brooker (AWS), [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Google SRE Book: Handling Overload（重试预算）](https://sre.google/sre-book/handling-overload/)
- 实战代码：LLMGateway `gateway/errors.py`（`is_retryable_status`）、`gateway/backends/anthropic.py`（`max_retries=0`）；DocPilot `store.py`（`ON CONFLICT DO NOTHING`）、`schema.sql`、`db.py`（`init_schema`）、`agent/tools.py`（`create_page`）
