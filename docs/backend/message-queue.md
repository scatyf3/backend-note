---
title: 消息队列：队列模型、日志模型与投递语义
status: draft
tags: [message-queue, kafka, rabbitmq, sqs, at-least-once]
difficulty: 3
order: 11
related: [/backend/idempotency, /backend/background-jobs, /backend/outbox-event-driven, /backend/os-io-models, /backend/concurrency-models]
stack: [mq-broker]
---

# {{ $frontmatter.title }}

## 一句话结论

消息队列把「生产」和「消费」在**时间**和**空间**上解耦，带来削峰填谷、异步化、一对多扇出和故障隔离。它有两种模型：

- **队列模型**（RabbitMQ、SQS）：一条消息被某个消费者取走、确认后就删除，按消息确认；
- **日志模型**（Kafka）：消息追加到分区日志里，消费者自己记录读到哪个 offset，可以回放，多个消费组互不影响。

==默认的投递语义是 at-least-once，所以消费者必须幂等；顺序只在一个分区（或一个消息组）内保证。==

## 为什么需要消息队列

同步调用链有三个问题：

1. **延迟叠加**：下单要同步调用库存、支付、通知、积分，任何一个慢都拖慢整体。
2. **故障传播**：通知服务挂了，下单也跟着失败，尽管通知根本不是下单的必要步骤。
3. **峰值压力**：秒杀的瞬时流量直接压到每一个下游。

在中间放一个队列：

- **异步化**：主流程只负责把消息写进队列，非关键步骤由消费者慢慢处理；
- **削峰填谷**：峰值流量先进队列积压起来，消费者按自己的能力匀速处理；
- **扇出**：一个事件（订单已创建）可以被多个系统独立消费；
- **故障隔离**：消费者挂了，消息积压在队列里，恢复后继续处理，生产者不受影响。

代价：系统变成**最终一致**的；多了一个需要运维的组件；调试和追踪更难；还要处理重复、乱序、积压这些新问题。

## 两种模型

### 队列模型：RabbitMQ、SQS

- 消费者取走一条消息，**处理完再确认（ack）**，broker 收到确认后删除。
- **SQS 的可见性超时**：消息被取走后在一段时间内（默认 30 秒）对别的消费者不可见；超时之前没有删除，它会**重新出现**，被别的消费者再处理一次。处理时间超过可见性超时，就会产生重复。
- **死信队列（DLQ）**：一条消息被接收了 N 次仍然失败（SQS 的 `maxReceiveCount`），就转到 DLQ，避免一条「毒消息」无限重试、堵住队列。
- **RabbitMQ 的路由**：生产者发给 exchange，再按类型（direct / topic / fanout）路由到队列；`prefetch` 控制一个消费者最多同时持有多少条未确认的消息。
- **SQS FIFO**：消息组内有序；用去重 id 在 5 分钟的窗口内去除重复。

### 日志模型：Kafka

- **topic** 分成多个 **partition**，每个 partition 是一个**只追加的有序日志**，每条消息有一个递增的 **offset**。
- 消费者**自己记录 offset**（提交到 Kafka），broker 不会因为消息被消费就删除它，而是按保留策略（时间或大小）清理。所以：
  - 可以**回放**：把 offset 往回拨，重新处理历史数据（修 bug 之后重算、新系统冷启动）；
  - **多个消费组**各自维护 offset，互不影响，天然支持扇出。
- **消费组内的并行度**：一个 partition 在同一个消费组内只分配给一个消费者，所以**并行度的上限等于 partition 数**。消费者多于 partition 的话，多出来的会空闲。
- **按 key 分区**：相同 key 的消息进同一个 partition，保证**同一个 key 内有序**（比如同一个订单的所有事件）。
- **持久性**：每个 partition 有多个副本，`acks=all` 加上 `min.insync.replicas` 保证写入多个副本才算成功。
- **log compaction**：对每个 key 只保留最新的值，适合当成「状态的变更日志」用。
- **为什么快**：顺序写磁盘、大量依赖 page cache、批量发送、消费时用 `sendfile` 零拷贝（见 [OS 与 IO 模型](/backend/os-io-models)）。

### 怎么选

| | 队列模型（RabbitMQ / SQS） | 日志模型（Kafka） |
|---|---|---|
| 消费后 | 删除 | 保留，可以回放 |
| 扇出 | 要配置多个队列或 fanout exchange | 多个消费组天然支持 |
| 顺序 | FIFO 队列 / 消息组内有序 | partition 内有序 |
| 单条消息的处理 | 可以逐条确认、延迟、重试，配合 DLQ | 按 offset 前进，一条消息卡住会阻塞整个 partition |
| 典型用途 | 任务分发、工作队列 | 事件流、数据管道、CDC、需要回放的场景 |

小规模的场景，也可以直接用 **Redis Streams**，或者 **PostgreSQL 的 `SELECT ... FOR UPDATE SKIP LOCKED`** 做队列，少一个组件（见[后台任务](/stack/mq-jobs)）。

## 投递语义

| 语义 | 做法 | 后果 |
|---|---|---|
| at-most-once | 先确认，再处理 | 处理中途崩溃，**消息丢失** |
| **at-least-once** | 先处理，再确认 | 处理完、确认前崩溃，**消息重复** |
| exactly-once（效果上） | at-least-once + **幂等处理** | 需要业务配合 |

绝大多数系统选 at-least-once，然后让消费者幂等：消费者维护一张「已处理的消息 id」表，**和业务写入放在同一个事务里**提交；或者让业务操作本身幂等（见[幂等与错误语义](/backend/idempotency)）。Kafka 的事务能把「消费 offset 的提交」和「输出消息的写入」放在一个原子操作里，但它只覆盖 Kafka 内部，写外部数据库仍然要靠幂等。

## 顺序

- **全局有序**意味着只有一个 partition、一个消费者，没有并行度可言，几乎从不值得。
- **按 key 有序**是常见的做法：同一个实体的事件进同一个 partition。
- **重试会打乱顺序**：一条消息失败后放进重试队列，后面的消息先被处理了。对顺序敏感的场景，要么在 partition 内阻塞重试（会拖慢这个 partition），要么让消费者能处理乱序（比如带上版本号，旧版本的事件直接忽略）。

## 运维：积压与毒消息

- **consumer lag**（消费者落后生产者多少条消息）是最重要的指标，也是消费者自动扩缩容的信号。Kafka 扩容时要注意，消费者数量不能超过 partition 数。
- **rebalance**：Kafka 消费组成员变化时会重新分配 partition，期间消费会暂停，频繁扩缩容或消费者处理超时都会导致反复 rebalance。
- **毒消息**：一条永远处理不了的消息（格式错误、触发 bug），要有最大重试次数，然后进 DLQ，并告警，由人工处理。

## AI 应用里的队列

- **供应商限流**：LLM 供应商有 RPM / TPM 限额，突发的批量请求（批量打标、eval、文档入库）直接打过去会大量 429。先放进队列，由消费者按限额匀速消费，比在每个调用方各自重试稳定得多。
- **入库管线**：解析 → 切分 → embedding → 写库，每一步都慢，适合拆成队列驱动的任务。DocPilot 目前在上传请求里**同步**完成整个入库，大文件会阻塞事件循环（见 [OS 与 IO 模型](/backend/os-io-models)），改成队列加后台 worker 是自然的下一步（见[后台任务](/stack/mq-jobs)）。
- **进程内的后台任务不是队列**：LLMGateway 把计费、写缓存放在 Starlette 的 `BackgroundTask` 里，在响应发出之后执行，不增加延迟。但它是**进程内**的：进程在这期间崩溃，这些工作就丢了；并发请求在计费写入之前都能通过预算检查。README 明确写了预算因此是一个**软上限**。==需要「保证做完」的工作，要放进持久化的队列，而不是进程内的后台任务==。

## 追问

::: details 为什么要引入消息队列？代价是什么？
好处：异步化（非关键步骤不阻塞主流程）、削峰填谷、一对多扇出、故障隔离（消费者挂了不影响生产者）。代价：系统变成最终一致的；多一个组件要运维；要处理重复、乱序、积压和毒消息；端到端的追踪和调试更难。
:::

::: details Kafka 和 RabbitMQ / SQS 的核心区别是什么？
Kafka 是分区的追加日志，消息消费后不删除，消费者自己记录 offset，可以回放，多个消费组独立消费，partition 内有序，吞吐很高，适合事件流和数据管道。RabbitMQ / SQS 是队列，消息被确认后删除，支持单条消息的确认、延迟、重试和 DLQ，适合任务分发。
:::

::: details 消息队列的三种投递语义是什么？怎么实现「效果上的 exactly-once」？
at-most-once（先确认再处理，可能丢）、at-least-once（先处理再确认，可能重复）、exactly-once。工程上用 at-least-once 加幂等处理实现效果上的 exactly-once：消费者把「消息 id 已处理」和业务写入放进同一个数据库事务，或者让业务操作本身幂等。Kafka 事务只能保证 Kafka 内部的原子性，写外部系统仍然要幂等。
:::

::: details Kafka 怎么保证顺序？消费组的并行度受什么限制？
只在 partition 内有序。需要顺序的消息用同一个 key，保证进入同一个 partition。一个 partition 在一个消费组内只分配给一个消费者，所以并行度上限等于 partition 数，消费者多于 partition 时会有空闲。partition 数要按预期的峰值并行度提前规划，后加 partition 会改变 key 到 partition 的映射，破坏按 key 的顺序。
:::

::: details SQS 为什么会出现重复消息？怎么处理？
消费者取走消息后，消息在可见性超时内对别人不可见。处理时间超过超时（默认 30 秒）还没删除，或者消费者在删除前崩溃，消息就会重新出现被再次处理。处理办法：可见性超时设得比最长处理时间更长，长任务中途调用 API 延长超时；消费者做幂等；超过最大接收次数就转入 DLQ。
:::

::: details 什么是毒消息？怎么处理？
一条永远处理不了的消息（格式错误、触发 bug）。如果无限重试，它会一直占用消费者，在 Kafka 里还会阻塞整个 partition 的后续消息。处理办法：限制最大重试次数，超过后放进死信队列并告警，人工排查后修复数据或代码，再重新投递。
:::

::: details 进程内的后台任务（比如 Starlette 的 BackgroundTask）和消息队列有什么区别？
后台任务在同一个进程里、响应发出之后执行，实现简单，不增加请求延迟，但不持久化：进程崩溃或重启时任务会丢失，也没有重试和积压的可见性。LLMGateway 用它做计费，接受的代价是预算变成软上限。需要保证一定完成的工作（扣款、发通知、入库），要放进持久化的队列，由独立的 worker 处理。
:::

## 参考

- Jay Kreps, [The Log: What every software engineer should know about real-time data's unifying abstraction](https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying)
- [Apache Kafka Documentation: Design](https://kafka.apache.org/documentation/#design)
- [Amazon SQS: Visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)、[Dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [RabbitMQ Tutorials](https://www.rabbitmq.com/tutorials)
- Martin Kleppmann, *Designing Data-Intensive Applications*，第 11 章（流处理）
- 实战代码：LLMGateway `gateway/pipeline.py`（`BackgroundTask`）与 README「Accounting off the hot path」一节；DocPilot `routes/documents.py`（同步入库）
