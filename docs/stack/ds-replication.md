---
title: 复制与一致性
---

# 复制与一致性

复制带来高可用、读扩展和就近访问，代价是副本之间的不一致。单主复制里，同步还是异步决定了故障时会不会丢数据；读从库会遇到读不到自己刚写的、时间倒流等异常；故障切换要防脑裂（fencing token）。多主要解决写冲突（LWW 会丢数据，CRDT 可以自动合并）。无主复制靠 $R + W > N$ 的 quorum。CAP 的正确理解是：分区发生时只能在一致性和可用性之间选。Raft 用任期、随机超时、多数派投票和提交，让 2f+1 个节点容忍 f 个故障。

- **AI 应用的坑**：会话历史从落后的只读副本读取，模型会「忘了」刚才那一轮；历史要从主库读。
- **LLMGateway 的状态全在 Redis**，Redis 是异步复制，故障切换可能丢掉最近的计数，好在限流和预算本来就是软上限。
- **不要用不同机器的时间戳判断先后**，时钟有偏差还可能回拨。

笔记：[复制与一致性：主从、quorum、CAP 与 Raft](/backend/replication-consensus)

**延伸阅读**：[Raft 论文](https://raft.github.io/raft.pdf)、[Dynamo 论文](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)
