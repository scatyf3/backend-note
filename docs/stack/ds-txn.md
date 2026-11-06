---
title: 分布式事务与 Saga
---

# 分布式事务与 Saga

跨服务的「要么全成要么全不成」很难。2PC 的参与者准备之后要持锁等待协调者，协调者崩溃就会阻塞，跨服务几乎不用；分布式数据库内部的 2PC 可行，是因为参与者和协调者都是用共识复制的组。实践中用 Saga：一串本地事务，每步配一个补偿，失败时逆序补偿，越过关键点后只向前重试。或者用 TCC：Try 预留、Confirm 确认、Cancel 释放，要处理幂等、空回滚和悬挂。两者都缺少隔离性，靠语义锁、版本号、重新读取来缓解。

- **补偿是语义撤销**（退款、更正通知），不是回滚，必须可以重试并且幂等。
- **LLMGateway 的预算是一个没做 Try 的 TCC**：请求前只检查不预留，所以是软上限；README 里写了预留估算成本的硬上限方案。
- **agent 的多步预订就是 Saga**：补偿也要作为工具提供，关键点前加人工审批，补偿链写成确定性的工作流。

笔记：[分布式事务：2PC、Saga 与 TCC](/backend/distributed-transactions)

**延伸阅读**：[Sagas (1987)](https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf)、[Life beyond Distributed Transactions](https://queue.acm.org/detail.cfm?id=3025012)
