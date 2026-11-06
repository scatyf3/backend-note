---
title: 索引、事务与隔离级别
---

# 索引、事务与隔离级别

这一格是关系数据库的两根支柱。索引用 B+ 树（一个节点一页、扇出几百、叶子节点用链表相连）把全表扫描变成几次页读取，代价是写放大。事务用 WAL 保证原子性和持久性，用 MVCC 加锁实现隔离。隔离级别是并发性能和异常之间的交易：RC 防脏读，RR 防不可重复读，Serializable 才防得住写偏斜。线上最常见的问题是读-改-写丢更新、长事务导致表膨胀和锁等待，以及索引因为写法问题没用上。

- **联合索引要同时服务 WHERE 和 ORDER BY**：DocPilot 的 `(conversation_id, created_at)` 对应「查某个会话、按时间排序」。
- **事务里不要调用外部服务**：DocPilot 先算 embedding，再开一个短事务写入文档和所有 chunk。
- **PostgreSQL 的 `now()` 是事务开始的时间**：同一事务里的两行时间戳相同，DocPilot 改用 `clock_timestamp()`，更稳妥的是加一个序号列。

笔记：[索引、事务与隔离级别](/backend/sql-index-transaction)

**延伸阅读**：[PostgreSQL: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)、[Use The Index, Luke](https://use-the-index-luke.com/)
