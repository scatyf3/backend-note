import type { Card } from '@lib/flashcards'

const R = '/backend/message-queue'

export const cards: Card[] = [
  {
    id: 'mq-why',
    deck: 'backend',
    topic: '消息队列',
    q: '为什么要在系统里引入消息队列？代价是什么？',
    a: '**好处**：\n1. **异步化**：主流程只写消息，非关键步骤（通知、积分）不阻塞；\n2. **削峰填谷**：峰值先积压在队列里，消费者匀速处理；\n3. **扇出**：一个事件被多个系统独立消费；\n4. **故障隔离**：消费者挂了，消息积压，生产者不受影响。\n**代价**：系统变成最终一致的；多一个组件要运维；要处理**重复、乱序、积压、毒消息**；端到端追踪更难。',
    ref: `${R}#为什么需要消息队列`,
  },
  {
    id: 'mq-kafka-vs-queue',
    deck: 'backend',
    topic: 'Kafka',
    q: 'Kafka 和 RabbitMQ / SQS 的核心区别是什么？各适合什么场景？',
    a: '- **Kafka（日志模型）**：分区的**追加日志**，消费后**不删除**，消费者自己记录 offset，可以**回放**；多个消费组独立消费；partition 内有序；吞吐很高。适合事件流、数据管道、CDC。\n- **RabbitMQ / SQS（队列模型）**：消息被确认后**删除**，支持**逐条**确认、延迟、重试和 DLQ。适合任务分发、工作队列。\nKafka 里一条消息卡住会阻塞整个 partition；队列模型可以单独重试这一条。',
    ref: `${R}#怎么选`,
  },
  {
    id: 'mq-delivery-semantics',
    deck: 'backend',
    topic: '投递语义',
    q: '三种投递语义分别对应「确认」和「处理」怎样的先后顺序？效果上的 exactly-once 怎么实现？',
    a: '- **at-most-once**：先确认再处理，处理中途崩溃 → **丢消息**。\n- **at-least-once**：先处理再确认，确认前崩溃 → **重复**。\n- **exactly-once（效果上）**：at-least-once + **幂等处理**。\n实现：消费者把「消息 id 已处理」和业务写入放进**同一个数据库事务**，或者让业务操作本身幂等。Kafka 事务只保证 Kafka 内部的原子性，写外部系统仍然要幂等。',
    ref: `${R}#投递语义`,
  },
  {
    id: 'mq-kafka-order-parallelism',
    deck: 'backend',
    topic: 'Kafka',
    q: 'Kafka 怎么保证顺序？消费组的并行度受什么限制？为什么不能随便加 partition？',
    a: '**只在 partition 内有序**。需要顺序的消息用**同一个 key**，进入同一个 partition（比如同一个订单的所有事件）。\n一个 partition 在一个消费组内只分配给**一个**消费者，所以**并行度上限 = partition 数**，多出来的消费者会空闲。\n后加 partition 会改变 key 到 partition 的映射，**破坏按 key 的顺序**，所以 partition 数要按预期峰值提前规划。',
    ref: `${R}#日志模型-kafka`,
  },
  {
    id: 'mq-sqs-duplicates',
    deck: 'backend',
    topic: 'SQS',
    q: 'SQS 为什么会出现重复消息？怎么应对？',
    a: '消费者取走消息后，消息在**可见性超时**（默认 30 秒）内对别人不可见。处理时间超过超时还没删除，或者消费者在删除前崩溃，消息就会**重新出现**，被再处理一次。\n应对：\n1. 可见性超时设得比最长处理时间更长，长任务中途调用 API **延长**超时；\n2. 消费者做**幂等**；\n3. 超过 `maxReceiveCount` 就转入 **DLQ**。',
    ref: `${R}#队列模型-rabbitmq、sqs`,
  },
  {
    id: 'mq-poison-lag',
    deck: 'backend',
    topic: '运维',
    q: '什么是毒消息？什么是 consumer lag？它们各自该怎么处理？',
    a: '**毒消息**：一条永远处理不了的消息（格式错误、触发 bug）。无限重试会一直占用消费者，在 Kafka 里还会**阻塞整个 partition**。处理：限制最大重试次数，然后放进**死信队列**并告警，人工修复后重新投递。\n**consumer lag**：消费者落后生产者多少条消息，是最重要的指标，也是**自动扩缩容**的信号。Kafka 扩容时消费者数不能超过 partition 数，还要注意 rebalance 期间消费会暂停。',
    ref: `${R}#运维-积压与毒消息`,
  },
  {
    id: 'mq-why-kafka-fast',
    deck: 'backend',
    topic: 'Kafka',
    q: 'Kafka 为什么能做到很高的吞吐？',
    a: '1. **顺序写磁盘**：只追加，不随机写；\n2. **大量依赖 page cache**：最近写入的数据通常直接从内存读；\n3. **批量**：生产者和 broker 都按批发送和写入，还可以压缩；\n4. **零拷贝**：消费时用 `sendfile` 把数据从 page cache 直接送进 socket，不经过用户态；\n5. **分区并行**：多个 partition 分布在多个 broker 上，读写都能横向扩展。',
    ref: `${R}#日志模型-kafka`,
  },
  {
    id: 'mq-bgtask-vs-queue',
    deck: 'backend',
    topic: '消息队列',
    q: 'LLMGateway 用 Starlette 的 `BackgroundTask` 在响应之后做计费。它和真正的消息队列有什么区别？带来什么后果？',
    a: '`BackgroundTask` 在**同一个进程**里、响应发出之后执行：实现简单，不增加请求延迟，但**不持久化**。进程崩溃或重启，正在执行的任务就丢了，也没有重试、积压的可见性。\n后果：并发请求在计费写入之前都能通过预算检查，所以 LLMGateway README 明确说**预算是软上限**（每个并发请求可能多超支一点）。\n原则：**需要保证做完的工作**（扣款、通知、入库），要放进持久化队列，交给独立的 worker。',
    ref: `${R}#ai-应用里的队列`,
  },
]
