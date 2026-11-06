---
title: 后台任务：202、租约、重试与限速
status: draft
tags: [background-jobs, worker, queue, retry, rate-limit]
difficulty: 3
order: 12
related: [/backend/message-queue, /backend/idempotency, /backend/os-io-models, /backend/outbox-event-driven, /backend/durable-execution]
stack: [mq-jobs]
---

# {{ $frontmatter.title }}

## 一句话结论

后台任务把**慢的、可以延后的、可能失败需要重试的**工作从请求路径里拿出去：请求只负责入队，立即返回 `202 Accepted` 和一个任务 id，由 worker 去拉取任务执行。可靠性来自四件事：

1. **持久化的任务存储**；
2. **租约 / 可见性超时**：worker 崩溃后，任务能自动回到队列；
3. **带退避的重试和死信**；
4. **幂等的任务处理**。

在这之上，还要有进度查询、超时、优先级和并发上限。==对 LLM 应用来说，并发上限尤其重要：它是让批量任务待在供应商限额以内的阀门。==

## 为什么不在请求里做完

- **请求有时间限制**：浏览器、LB、网关都有超时（AWS ALB 默认 60 秒），解析一个大 PDF 再算几百个 embedding，很容易超时。
- **会拖垮服务**：同步做 CPU 密集的工作会阻塞事件循环，同一个进程上的所有请求都会卡住（见 [OS 与 IO 模型](/backend/os-io-models)）。
- **失败难处理**：embedding API 返回 429 或 5xx，在请求里重试只会让用户等得更久；放弃的话，用户就得重新上传。
- **峰值**：一次上传 100 个文件，同步处理就是 100 个同时运行的重活。

一般来说，超过几百毫秒、依赖外部服务、可以批量做、需要定时执行的工作，都适合交给后台任务。

## 基本形态

```
POST /documents        → 存原始文件，插入 job(status=queued)，返回 202 + {job_id}
GET  /jobs/{job_id}    → {status: queued | running | succeeded | failed, progress, error}
worker:  取任务（加租约）→ 执行 → 写结果 → 标记完成（失败则按策略重试）
```

客户端拿到结果的三种方式：轮询状态接口；服务端推送（SSE / WebSocket）；完成后回调 webhook。

## 可靠性：任务不能丢，也不能卡死

### 租约（lease）/ 可见性超时

worker 取任务时，并不删除它，而是给它一个租约：「这个任务归我，30 秒内有效」。

- worker 正常完成：删除任务，或者标记为完成。
- worker 崩溃：租约过期，任务重新变得可见，被别的 worker 取走。
- 任务本身就很长：worker 要定期**续约**（心跳），否则做到一半会被别人再做一遍。

这和 SQS 的可见性超时是同一个机制（见[消息队列](/backend/message-queue)）。它带来的直接后果是：==任务可能被执行不止一次（at-least-once），所以任务处理必须幂等==（见[幂等与错误语义](/backend/idempotency)）。

### 重试和死信

- **区分错误类型**：429、5xx、超时可以重试；参数错误、文件损坏属于永久性错误，重试多少次都没用，应该直接标记失败。
- **指数退避加抖动**，并设置最大尝试次数。
- **死信**：超过最大次数仍然失败的任务，移到死信队列并告警，保留现场，方便排查之后重放。
- **超时**：每个任务有执行时间上限，卡死的任务要能被识别和中止。

### 优雅关闭

发布或缩容时，worker 会收到 SIGTERM：停止领取新任务，在宽限期内完成手上的任务；来不及完成的，主动释放租约（或者等租约自然过期），交给别的 worker 继续。

## 用 PostgreSQL 做任务队列

规模不大时，不必单独引入 Redis 或 RabbitMQ，用一张表就能实现：

```sql
-- worker 领取一个任务
UPDATE jobs SET status = 'running', locked_until = now() + interval '30 seconds', attempts = attempts + 1
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'queued' OR (status = 'running' AND locked_until < now())
  ORDER BY priority, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

关键是 **`FOR UPDATE SKIP LOCKED`**：多个 worker 并发领取时，被别人锁住的行直接跳过，不会互相等待，也不会领到同一个任务。

好处：

- **入队可以和业务写入放在同一个事务里**：「创建文档记录」和「创建入库任务」要么都成功，要么都失败。这其实就是 [Outbox](/stack/mq-outbox) 的思路。
- 少维护一个系统，任务状态可以直接用 SQL 查询、和业务表 join。

限制：吞吐比不上专门的消息系统；频繁更新会产生大量死元组，需要关注 VACUUM。现成的实现有 graphile-worker、pgmq、River（Go）、Oban（Elixir）等。

## 并发控制和公平性

### 对下游限速

后台任务最容易打垮的是**下游**。100 个 worker 同时调用 embedding API，立刻就是一片 429。需要一个**所有 worker 共享**的限速器：

- 简单场景：限制 worker 数量或者每个 worker 的并发数（DocPilot 的 eval 用 `asyncio.Semaphore` 把并发限制在 4，但这只在一个进程内有效）；
- 多个 worker：用 Redis 做分布式令牌桶，同时限制每分钟请求数和每分钟 token 数（RPM + TPM）。LLMGateway 就是用一段 Lua 脚本原子地检查和扣减两个桶（见 [LLM 网关](/stack/gw-routing)）。更简单的做法是让所有 worker 都通过网关调用模型，限速统一由网关负责。

### 租户之间的公平

一个用户一次上传 1 万个文档，如果按 FIFO 处理，其他用户的单个文件要排在 1 万个任务后面。解决办法：按租户分队列轮询、限制每个租户同时运行的任务数，或者小任务走高优先级的队列。

### 定时任务

cron 类的任务部署了多个实例后，同一时刻会被执行多次。办法有：只让一个实例负责调度（选主）；给每次执行一个唯一键（比如「任务名 + 计划时间」），用唯一约束保证只入队一次；还要考虑服务停机期间错过的执行要不要补跑。

### 要监控的指标

队列深度、**最老任务的等待时间**（比深度更能反映用户感受到的延迟）、失败率、重试次数、执行耗时的分布。

## 实战：把 DocPilot 的入库改成后台任务

DocPilot 现在在上传请求里同步完成整个入库流程：解析 → 切分 → 调 embedding（每批 64 条，`embedding_batch_size`）→ 一个事务写入。问题前面几篇都提到过：大文件会阻塞事件循环，embedding API 失败时用户只能重新上传，批量上传时没有任何限速。

改造方案：

1. `POST /documents`：把原始文件存进对象存储（或数据库），**在同一个事务里**插入一条 `documents(status='processing')` 和一条入库任务，返回 202 和文档 id。
2. worker：领取任务 → 解析、切分 → 通过共享的限速器分批调用 embedding → **在一个事务里删除这个文档已有的 chunk 再插入新的**，并把状态改为 `ready`。先删后插让任务可以安全地重复执行（幂等）。
3. 失败：429 / 5xx 按退避重试；文件无法解析之类的永久错误，把状态改为 `failed` 并记下原因，让界面展示出来。
4. 前端的 Library 页面轮询文档状态（或者订阅 SSE）。

代价是用户体验变了：以前上传完马上知道分成了多少个 chunk，现在要等状态从 processing 变成 ready。对小文件，也可以保留一个同步的快速路径。

## 追问

::: details 什么样的工作应该放到后台任务里？
耗时超过几百毫秒的、依赖外部服务（可能失败要重试）的、CPU 密集的、可以批量处理的、定时执行的，以及用户不需要立刻拿到结果的工作。判断标准是：放在请求里，会不会超时、会不会阻塞其他请求、失败了好不好重试。
:::

::: details 后台任务怎么保证不丢、也不会因为 worker 崩溃而卡住？
任务持久化存储；worker 领取时加租约（可见性超时），而不是直接删除；完成后才删除或标记完成。worker 崩溃时租约过期，任务回到队列被别人领走；长任务要定期续约。因此任务可能执行多次，处理逻辑必须幂等。再加上重试上限和死信队列，防止一个坏任务无限重试。
:::

::: details 怎么用 PostgreSQL 实现一个任务队列？SKIP LOCKED 起什么作用？
一张 jobs 表，worker 用 `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` 选出一个可执行的任务，并在同一条 UPDATE 里把它改成 running、写上租约到期时间。`SKIP LOCKED` 让并发的 worker 跳过已经被别人锁住的行，不会互相等待，也不会领到同一个任务。好处是入队可以和业务写入在同一个事务里，代价是吞吐有限、需要关注 VACUUM。
:::

::: details 很多 worker 同时调用 LLM API，怎么避免集体触发 429？
需要一个所有 worker 共享的限速器：用 Redis 实现的分布式令牌桶，同时限制 RPM 和 TPM，检查和扣减用 Lua 脚本保证原子性（LLMGateway 的做法）。或者让所有 worker 都通过 LLM 网关调用，由网关统一限速和排队。worker 收到 429 时按 `Retry-After` 退避，而不是立即重试。单进程内的 Semaphore 管不住多个 worker。
:::

::: details 一个大客户提交了一万个任务，其他客户的任务全被堵住了，怎么办？
按租户实现公平调度：每个租户一个逻辑队列，worker 轮询各个租户；限制每个租户同时运行的任务数；按任务大小分优先级，小任务走快速队列。监控时按租户看「最老任务的等待时间」，而不只看总的队列深度。
:::

::: details 定时任务部署了 3 个实例，怎么保证每次只执行一次？
1. 选主：只有 leader 负责调度（用分布式锁或者 Kubernetes 的 leader election）；
2. 唯一键：每次执行用「任务名 + 计划时间」作为唯一键入队，靠数据库唯一约束去重；
3. 交给外部的调度器（Kubernetes CronJob、云厂商的定时触发器）。

还要决定停机期间错过的执行是否补跑，以及任务本身是否幂等。
:::

::: details 把 DocPilot 的文档入库改成后台任务，要注意哪些点？
1. 上传接口在同一个事务里写文档记录（status=processing）和入库任务，返回 202；
2. worker 通过共享的限速器调用 embedding；
3. 写入时在一个事务里先删除这个文档已有的 chunk 再插入，保证重复执行是幂等的；
4. 区分可重试错误和永久错误，失败原因写回文档状态；
5. 前端轮询或订阅状态。

代价是上传后不能立刻拿到结果，小文件可以保留同步的快速路径。
:::

## 参考

- [PostgreSQL: SELECT ... FOR UPDATE SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- Craig Ringer, [What is SKIP LOCKED for in PostgreSQL 9.5?](https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5/)
- [Amazon SQS: Visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Celery: Tasks（重试、幂等、acks_late）](https://docs.celeryq.dev/en/stable/userguide/tasks.html)
- [RFC 9110: 202 Accepted](https://www.rfc-editor.org/rfc/rfc9110#name-202-accepted)
- 实战代码：DocPilot `routes/documents.py`、`ingest/pipeline.py`、`embeddings.py`（`embedding_batch_size`）、`evals/run.py`（Semaphore）；LLMGateway `gateway/limits.py`
