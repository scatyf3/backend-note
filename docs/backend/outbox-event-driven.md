---
title: Outbox 与事件驱动：解决双写问题
status: draft
tags: [outbox, dual-write, cdc, event-driven, debezium]
difficulty: 4
order: 13
related: [/backend/message-queue, /backend/background-jobs, /backend/idempotency, /backend/sql-index-transaction, /backend/distributed-transactions, /ai/embedding-vector-index]
stack: [mq-outbox]
---

# {{ $frontmatter.title }}

## 一句话结论

**双写问题**：一个操作既要写数据库，又要发消息（或者调外部 API、写另一个存储），而这两步不可能放进同一个事务里，无论先做哪一步，都可能出现一边成功、一边失败。**Transactional Outbox** 的解法是：==在同一个本地事务里，同时写业务表和一张 outbox 表；再由一个独立的 relay 把 outbox 里的事件可靠地发出去，成功后标记为已发送==。它保证 at-least-once 投递，所以下游要幂等。事件驱动架构让服务之间通过事件通信，换来解耦和扩展性，代价是最终一致、链路难追踪，以及事件 schema 的演进成本。

## 为什么双写一定会出问题

「下单」需要两步：写 `orders` 表，发一个 `OrderCreated` 事件给库存和通知服务。

| 顺序 | 失败场景 | 结果 |
|---|---|---|
| 先写库，再发消息 | 写库成功后进程崩溃，或者消息发送失败 | **事件丢失**：订单存在，下游永远不知道 |
| 先发消息，再写库 | 消息发出了，写库失败（约束冲突、超时） | **幽灵事件**：下游处理了一个不存在的订单 |
| 写库的事务里发消息 | 消息发出后事务回滚 | 同上，而且事务里调用外部服务又是一个长事务 |

两阶段提交（2PC / XA）理论上能解决，但绝大多数消息系统和外部 API 不支持 XA，而且 2PC 有协调者单点和阻塞的问题，实践中几乎不用（见[分布式事务与 Saga](/stack/ds-txn)）。

## Transactional Outbox

### 写入

```sql
BEGIN;
INSERT INTO orders (...) VALUES (...);
INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
VALUES ('order', 42, 'OrderCreated', '{"order_id": 42, ...}');
COMMIT;
```

业务数据和「待发送的事件」在同一个本地事务里，要么都提交，要么都回滚。事件丢失和幽灵事件都不会出现。

### 投递：relay 的两种实现

**1. 轮询**

```sql
SELECT * FROM outbox WHERE published_at IS NULL
ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100;
-- 发送到消息队列，成功后：
UPDATE outbox SET published_at = now() WHERE id = ANY(...);
```

实现简单，任何数据库都能用；缺点是有轮询间隔带来的延迟和查询负载。PostgreSQL 可以配合 `LISTEN/NOTIFY` 在有新事件时唤醒 relay，减少空转。

**2. CDC（Change Data Capture）**

用 Debezium 这类工具读取数据库的变更日志（PostgreSQL 的 WAL、MySQL 的 binlog），把 outbox 表新插入的行转成消息发出去。延迟低，对数据库没有额外的查询压力，Debezium 还专门提供了 outbox 的路由组件；代价是要运维一套 CDC 基础设施。

### 语义和顺序

- **at-least-once**：relay 发送成功后、标记 `published_at` 之前崩溃，重启后会再发一次。所以下游必须幂等。
- **Inbox 模式**：消费者用一张「已处理的消息 id」表，和业务写入放在同一个事务里，在消费端实现去重（见[幂等](/backend/idempotency)）。
- **顺序**：同一个聚合（比如同一个订单）的事件要按顺序发出：按 id 排序，并且用 `aggregate_id` 作为消息的分区 key。多个 relay 并行时，要按聚合分片，否则同一个订单的事件可能乱序。
- **清理**：已发送的 outbox 记录要定期删除或归档，否则表会无限增长。

==Outbox 的本质，是把「跨系统的原子性」问题，转换成「本地事务 + 可重试的异步投递 + 幂等消费」==。同样的思路也适用于调用外部 API：先在本地事务里记下「要调用」，再由后台任务执行并重试（见[后台任务](/stack/mq-jobs)）。

## 事件驱动架构

### 三种事件

| 类型 | 事件里有什么 | 特点 |
|---|---|---|
| 事件通知 | 只有「发生了什么」和 id：`OrderCreated{id: 42}` | 小；但消费者要回调生产者查询详情，又耦合回去了 |
| 事件携带状态 | 带上消费者需要的数据快照 | 消费者可以独立工作，各自维护本地副本；事件更大，数据冗余 |
| 事件溯源 | 事件**本身就是**数据的唯一来源，当前状态由事件序列推导出来 | 完整的审计和回放能力；查询需要另外建投影（CQRS），复杂度高 |

### 编排（choreography）还是协调（orchestration）

- **编排**：没有中心，每个服务监听事件、做自己的事、再发出新的事件。耦合低，但整个流程散落在各个服务里，很难看清全貌，也很难排查「卡在哪一步了」。
- **协调**：一个中心的协调者（工作流引擎）明确地按步骤调用各个服务。流程清晰可见，便于处理补偿和超时，代价是协调者本身成为一个关键组件（见[工作流与 durable execution](/stack/mq-workflow)）。

### 代价

- **最终一致**：写入之后，下游要过一段时间才能看到变化，产品上要能接受这种延迟。
- **难以追踪**：一个请求触发了一串事件，要靠在事件里传递 trace id 才能串起来（见[可观测性](/stack/ops-observability)）。
- **schema 演进**：事件一旦发布，就有消费者依赖它。规则和 API 一样：只加可选字段，不改语义；需要破坏性变更时发布新版本的事件类型，借助 schema registry（Avro / Protobuf）在发布时校验兼容性（见 [API 设计](/backend/api-design)）。

## 实战：在同一个存储里，就不需要 Outbox

DocPilot 和 LLMGateway 的设计里，有好几处正好说明了「什么时候没有双写问题」：

1. **DocPilot：一个 Postgres 装下所有东西。** 文档、chunk、全文索引、向量都在同一个数据库里，`insert_document` 用一个事务写入文档和它的所有 chunk（包括向量）。==如果向量放在一个独立的向量数据库里，入库就变成了双写==：写 Postgres 成功、写向量库失败，文档就存在却永远搜不到；反过来，向量库里会出现对应不到任何文档的孤儿向量。那时就需要 outbox，或者定期对账（见 [Embedding 与向量索引](/ai/embedding-vector-index)）。
2. **DocPilot：一轮对话和它的 trace 原子写入。** `save_turn` 在一个事务里写会话、两条消息和 trace，因为都在同一个库里。
3. **LLMGateway：Redis 内部用事务。** 语义缓存写入一个条目要改三个 key（向量、响应、顺序列表），用 `pipeline(transaction=True)`（Redis 的 MULTI/EXEC）原子地完成。
4. **LLMGateway：接受了的双写。** 响应发给客户端之后，再把计费写进 Redis。这本质上是「响应」和「记账」两件事的双写：记账失败，这次请求就少记了钱。网关的选择是接受这个风险（预算是软上限），换取热路径上的低延迟。如果计费必须精确，就要先在本地持久化一条记账记录，再异步汇总，也就是 outbox 的思路。

**DocPilot 什么时候会需要 outbox**：比如 `create_page` 新建一篇文档后，要通知一个外部的搜索服务，或者给用户发一个 webhook，这就跨出了数据库，变成了双写。

## 追问

::: details 什么是双写问题？为什么调整写库和发消息的顺序解决不了？
一个操作需要同时写数据库和发消息，两者没法放进同一个事务。先写库后发消息，中间崩溃会丢事件；先发消息后写库，写库失败会产生幽灵事件；在数据库事务里发消息，事务回滚了消息也收不回来。任何顺序都有一种失败场景会导致不一致。
:::

::: details Transactional Outbox 是怎么解决双写的？
在同一个本地事务里写业务表和 outbox 表，业务数据和待发事件要么都提交、要么都回滚。再由一个独立的 relay（轮询 outbox 表，或者用 CDC 读取 WAL / binlog）把事件发到消息系统，成功后标记为已发送。relay 可能重复发送，所以是 at-least-once，消费者需要幂等（比如用 inbox 表去重）。
:::

::: details outbox 的 relay 用轮询还是 CDC？
- 轮询：实现简单，不需要额外的基础设施；有轮询间隔带来的延迟和数据库查询负载，可以用 `LISTEN/NOTIFY` 缓解。
- CDC（如 Debezium）：读取数据库变更日志，延迟低，对数据库没有额外的查询压力；需要运维一套 CDC 组件，并处理好日志保留和位点管理。

规模小用轮询，事件量大、对延迟敏感时用 CDC。
:::

::: details 为什么不用两阶段提交（2PC）解决双写？
绝大多数消息系统和外部 API 不支持 XA 协议；2PC 的协调者是单点，参与者在准备阶段之后要一直持有锁、等待协调者的决定，协调者故障会让参与者阻塞；性能也差。Outbox 只依赖本地事务和可重试的异步投递，更简单、更可靠。
:::

::: details 怎么保证同一个订单的事件按顺序被消费？
relay 按 outbox 的自增 id 顺序读取；发送时用 `aggregate_id`（订单 id）作为分区 key，同一个订单的事件进入同一个分区；多个 relay 并行时按聚合分片，同一个聚合只由一个 relay 处理。消费端也要能识别重复和乱序，比如在事件里带上版本号，旧版本直接忽略。
:::

::: details 「事件通知」和「事件携带状态」有什么区别？怎么选？
事件通知只说「发生了什么」加一个 id，事件很小，但消费者往往要回调生产者查询详情，又产生了同步耦合，生产者还要承受查询压力。事件携带状态把消费者需要的数据放进事件里，消费者可以独立工作、维护本地副本，代价是事件更大、数据冗余，schema 演进也更需要谨慎。消费者多、希望彼此解耦时，用事件携带状态。
:::

::: details 为什么说把向量和业务数据放在同一个 Postgres 里，能避免一类一致性问题？
文档、chunk 和向量在同一个数据库里，入库可以用一个本地事务完成，不存在部分成功的情况。如果向量放在独立的向量数据库里，入库就是双写：写关系库成功、写向量库失败，文档存在但搜不到；反过来会出现孤儿向量。那就需要 outbox 或者定期对账来补救。这是 DocPilot 选择「一个 Postgres 装下所有东西」的重要理由之一。
:::

## 参考

- Chris Richardson, [Pattern: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- [Debezium: Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- Martin Fowler, [What do you mean by "Event-Driven"?](https://martinfowler.com/articles/201701-event-driven.html)
- Martin Kleppmann, *Designing Data-Intensive Applications*，第 11 章（CDC、事件溯源）
- 实战代码：DocPilot `store.py`（`insert_document`、`save_turn`）、`schema.sql`；LLMGateway `gateway/cache/semantic.py`（`pipeline(transaction=True)`）、README「Accounting off the hot path」一节
