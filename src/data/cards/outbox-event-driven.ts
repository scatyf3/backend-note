import type { Card } from '@lib/flashcards'

const R = '/backend/outbox-event-driven'

export const cards: Card[] = [
  {
    id: 'outbox-dual-write',
    deck: 'backend',
    topic: '双写',
    q: '什么是双写问题？为什么调整「写库」和「发消息」的先后顺序解决不了？',
    a: '一个操作要同时写数据库和发消息，两者**没法放进同一个事务**：\n- **先写库再发消息**：中间崩溃或发送失败 → **事件丢失**；\n- **先发消息再写库**：写库失败 → **幽灵事件**，下游处理了一个不存在的订单；\n- **在 DB 事务里发消息**：事务回滚，消息却收不回来。\n任何顺序都有一种失败场景会导致不一致。',
    ref: `${R}#为什么双写一定会出问题`,
  },
  {
    id: 'outbox-how',
    deck: 'backend',
    topic: 'Outbox',
    q: 'Transactional Outbox 模式是怎么解决双写问题的？它提供什么投递语义？',
    a: '1. **同一个本地事务**里写业务表和 outbox 表，业务数据和待发事件要么都提交、要么都回滚；\n2. 独立的 **relay** 读取 outbox（轮询，或用 CDC 读 WAL / binlog），把事件发到消息系统，成功后标记为已发送。\n语义是 **at-least-once**：relay 发送成功、标记之前崩溃，会重发一次。所以消费者要**幂等**，比如用 inbox 表把「消息 id 已处理」和业务写入放在同一个事务里。',
    ref: `${R}#transactional-outbox`,
  },
  {
    id: 'outbox-polling-vs-cdc',
    deck: 'backend',
    topic: 'Outbox',
    q: 'outbox relay 用轮询和用 CDC 各有什么优缺点？',
    a: '- **轮询**（`SELECT ... WHERE published_at IS NULL FOR UPDATE SKIP LOCKED`）：实现简单，任何数据库都能用；缺点是有**轮询间隔带来的延迟**和数据库查询负载，PostgreSQL 可以用 `LISTEN/NOTIFY` 在有新事件时唤醒。\n- **CDC**（Debezium 读 WAL / binlog）：**延迟低**，不额外查询数据库；缺点是要运维一套 CDC 基础设施，处理日志保留和位点管理。\n规模小用轮询，事件量大、对延迟敏感时用 CDC。',
    ref: `${R}#投递-relay-的两种实现`,
  },
  {
    id: 'outbox-no-2pc',
    deck: 'backend',
    topic: '双写',
    q: '为什么实践中不用两阶段提交（2PC / XA）解决「写库 + 发消息」？',
    a: '1. 绝大多数消息系统和外部 API **不支持 XA**；\n2. **协调者是单点**：参与者在准备阶段之后要一直持有锁、等待决定，协调者故障会让参与者**阻塞**；\n3. 性能差，延迟高。\nOutbox 只依赖**本地事务 + 可重试的异步投递 + 幂等消费**，更简单也更可靠。',
    ref: `${R}#为什么双写一定会出问题`,
  },
  {
    id: 'outbox-ordering',
    deck: 'backend',
    topic: '顺序',
    q: '用 outbox 发事件时，怎么保证同一个订单的事件按顺序被消费？',
    a: '1. relay **按 outbox 的自增 id 顺序**读取；\n2. 发送时用 **`aggregate_id`（订单 id）作为分区 key**，同一个订单进同一个分区；\n3. 多个 relay 并行时**按聚合分片**，同一个聚合只由一个 relay 处理；\n4. 消费端也要能识别重复和乱序，比如事件带**版本号**，旧版本直接忽略。',
    ref: `${R}#语义和顺序`,
  },
  {
    id: 'outbox-event-types',
    deck: 'backend',
    topic: '事件驱动',
    q: '「事件通知」「事件携带状态」「事件溯源」三种事件有什么区别？',
    a: '- **事件通知**：只说发生了什么 + id。事件小，但消费者常要**回调生产者**查详情，又产生了耦合。\n- **事件携带状态**：带上消费者需要的数据快照，消费者能**独立工作**、维护本地副本；事件更大，数据冗余。\n- **事件溯源**：事件本身就是数据的**唯一来源**，当前状态由事件序列推导；有完整审计和回放能力，但查询要另建投影（CQRS），复杂度高。',
    ref: `${R}#三种事件`,
  },
  {
    id: 'outbox-same-store',
    deck: 'backend',
    topic: '实战',
    q: '为什么说 DocPilot 把向量和文档放在同一个 Postgres 里，避开了一类一致性问题？LLMGateway 又接受了哪个双写？',
    a: '**DocPilot**：文档、chunk、向量在同一个库里，`insert_document` 一个本地事务就能完成入库。如果向量放在独立的向量数据库里，就成了**双写**：写关系库成功、写向量库失败，文档存在却搜不到；反过来会有孤儿向量，就需要 outbox 或定期对账。\n**LLMGateway**：响应先发给客户端，**之后**才把计费写进 Redis。记账失败就会少记钱。它接受这个风险（预算是软上限），换取热路径的低延迟。',
    ref: `${R}#实战-在同一个存储里-就不需要-outbox`,
  },
  {
    id: 'outbox-choreo-orch',
    deck: 'backend',
    topic: '事件驱动',
    q: '事件驱动的编排（choreography）和协调（orchestration）有什么区别？',
    a: '- **编排**：没有中心，每个服务监听事件、做自己的事、再发出新事件。**耦合低**，但流程散落在各个服务里，**很难看清全貌**，也难排查「卡在哪一步」。\n- **协调**：一个中心协调者（工作流引擎）按步骤明确调用各服务。**流程清晰**，便于处理补偿和超时；代价是协调者成为关键组件。\n流程短、参与方少用编排；流程长、需要补偿和可见性用协调。',
    ref: `${R}#编排-choreography-还是协调-orchestration`,
  },
]
