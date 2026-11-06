---
title: 消息队列
---

# 消息队列

消息队列把生产和消费在时间和空间上解耦，用来异步化、削峰填谷、扇出和隔离故障，代价是系统变成最终一致的，还要处理重复、乱序和积压。队列模型（RabbitMQ、SQS）消息确认后删除，适合任务分发，靠可见性超时和 DLQ 处理失败；日志模型（Kafka）是分区的追加日志，消费者自己维护 offset，可以回放，多个消费组独立消费，并行度上限等于 partition 数。默认语义是 at-least-once，消费者必须幂等。

- **顺序只在 partition / 消息组内保证**，同一实体的消息用同一个 key；重试会打乱顺序。
- **SQS 的重复**来自可见性超时：处理时间超过超时，消息会重新出现。
- **进程内的后台任务不是队列**：LLMGateway 用 `BackgroundTask` 计费，崩溃会丢，所以预算是软上限。

笔记：[消息队列：队列模型、日志模型与投递语义](/backend/message-queue)

**延伸阅读**：[The Log（Jay Kreps）](https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying)、[Kafka Design](https://kafka.apache.org/documentation/#design)
