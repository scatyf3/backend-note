---
title: 后台任务
---

# 后台任务

后台任务把慢的、可延后的、可能失败的工作移出请求路径：请求只入队并返回 202 和任务 id，worker 领取后执行。可靠性靠持久化的任务存储、租约 / 可见性超时（worker 崩溃后任务能回来）、带退避的重试加死信，以及幂等的任务处理。还要有进度查询、超时、优先级、租户间的公平调度，以及所有 worker 共享的下游限速。小规模可以直接用 PostgreSQL 的 `FOR UPDATE SKIP LOCKED` 做队列，入队还能和业务写入放进同一个事务。

- **租约意味着 at-least-once**：任务可能执行多次，处理必须幂等（比如先删除旧 chunk 再插入）。
- **限速要跨 worker 共享**：单进程的 Semaphore 管不住多个 worker，用 Redis 令牌桶，或者统一走 LLM 网关。
- **DocPilot 的入库适合改成后台任务**：同步解析和 embedding 会阻塞事件循环，失败了也没法重试。

笔记：[后台任务：202、租约、重试与限速](/backend/background-jobs)

**延伸阅读**：[What is SKIP LOCKED for](https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5/)、[Celery: Tasks](https://docs.celeryq.dev/en/stable/userguide/tasks.html)
