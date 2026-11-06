---
title: Outbox 与事件驱动
---

# Outbox 与事件驱动

双写问题：写数据库和发消息没法放进同一个事务，任何顺序都可能一边成功一边失败，导致事件丢失或出现幽灵事件。Transactional Outbox 在同一个本地事务里写业务表和 outbox 表，再由 relay（轮询或 CDC）可靠地投递，at-least-once，消费端靠 inbox 表去重。事件驱动架构带来解耦和扩展性，代价是最终一致、链路难追踪、事件 schema 要谨慎演进；编排和协调各有取舍。

- **同一个存储里不需要 outbox**：DocPilot 把向量和文档放在同一个 Postgres，入库一个事务完成；向量放在独立的向量库就成了双写。
- **顺序按聚合保证**：outbox 按 id 读，用 `aggregate_id` 作为分区 key。
- **LLMGateway 接受了一个双写**：响应发出之后才计费，记账失败就会少记钱，用来换热路径的低延迟。

笔记：[Outbox 与事件驱动](/backend/outbox-event-driven)

**延伸阅读**：[Pattern: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)、[Debezium Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
