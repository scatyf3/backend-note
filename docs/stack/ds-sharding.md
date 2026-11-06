---
title: 分片
---

# 分片

分片按某个 key 把数据切到多台机器上，突破单机的容量和写吞吐上限。核心决策是分片键（基数高、分布均匀、查询都带着它、不单调递增）和分片策略：范围分片利于范围查询但有热点；哈希分片均匀，但 `mod N` 一扩容几乎全部数据要迁移；一致性哈希或固定数量的逻辑分片（Redis Cluster 的 16384 个 slot）扩容时只移动一小部分。代价是跨分片的查询、join、二级索引、唯一约束和事务都变难了，所以分片是读写分离、缓存、表分区都不够之后的最后手段。

- **多租户 RAG 按租户分片**：查询只命中一个分片，天然隔离，也避开了带过滤的 HNSW 召回问题。
- **Redis Cluster 的多 key 操作必须在同一个 slot**：LLMGateway 限流脚本的两个 key 要加 hash tag（`rl:{id}:rpm`）。
- **全局 id** 用雪花算法或 UUIDv7，既唯一又大致有序。

笔记：[分片：分片键、哈希、一致性哈希与重新平衡](/backend/sharding)

**延伸阅读**：[Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)、[Consistent Hashing](https://www.cs.princeton.edu/courses/archive/fall09/cos518/papers/chash.pdf)
