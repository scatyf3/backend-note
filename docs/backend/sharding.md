---
title: 分片：分片键、哈希、一致性哈希与重新平衡
status: draft
tags: [sharding, partitioning, consistent-hashing, redis-cluster, distributed]
difficulty: 4
order: 16
related: [/backend/replication-consensus, /backend/distributed-transactions, /backend/nosql-fulltext, /backend/caching, /ai/embedding-vector-index]
stack: [ds-sharding]
---

# {{ $frontmatter.title }}

## 一句话结论

分片（sharding / partitioning）按某个 key 把数据切到多台机器上，突破单机的容量和写吞吐上限。核心决策只有两个：==**分片键**选什么，和**分片策略**用哪种==（范围、哈希、一致性哈希 / 固定数量的逻辑分片、目录）。代价是所有「跨分片」的事情都变难了：跨分片查询、join、事务、全局唯一约束和二级索引，以及扩容时的数据迁移。所以分片是最后的手段：先垂直扩容、读写分离、加缓存、归档冷数据，实在不够再水平分片。

## 为什么、以及什么时候才分片

复制解决的是读扩展和可用性（见[复制与一致性](/backend/replication-consensus)），但**每个副本存的都是全量数据，写入也都要经过主库**。当以下任一条件成立时，复制就不够了：

- 数据量超过单机的磁盘或内存；
- 写入吞吐超过单个主库的能力；
- 单个表大到索引维护、VACUUM、备份恢复都变得很痛苦。

在走到分片之前，还有一串更便宜的手段：换一台更大的机器；读写分离；加缓存；把冷数据归档；在单机内用**表分区**（PostgreSQL 的声明式分区，按时间或租户切成多个子表，查询自动裁剪分区）。分片会让整个应用的复杂度上一个台阶，所以往往放在最后。

## 分片策略

### 范围分片

按 key 的范围切：用户 id 1–100 万在分片 1，100 万–200 万在分片 2。Bigtable、HBase、TiKV 的 region 都是这种方式，并且分片太大会自动分裂。

- **优点**：范围查询只命中少数分片；天然有序。
- **缺点**：**热点**。如果 key 是单调递增的（自增 id、时间戳），所有新写入都落在最后一个分片上。

### 哈希分片

`shard = hash(key) mod N`。

- **优点**：分布均匀，没有顺序热点。
- **缺点**：范围查询要发给所有分片（scatter-gather）。更大的问题是**扩容**：N 从 4 变成 5，`hash mod N` 的结果几乎全部改变，大约 $N/(N+1)$ 的数据需要搬家。

### 一致性哈希和逻辑分片

**一致性哈希**：把哈希空间想象成一个环，节点和 key 都映射到环上，key 归顺时针方向遇到的第一个节点。增加一个节点时，只有它在环上「接管」的那一段 key 需要移动，大约占总量的 $1/N$。为了让分布均匀，每个物理节点在环上放很多个**虚拟节点**。Dynamo 和 Cassandra 用的就是这种方式。

**固定数量的逻辑分片**是工程上更常见的做法：一开始就把数据切成远多于节点数的逻辑分片，再把逻辑分片分配给节点。扩容时**整块迁移逻辑分片**，key 和逻辑分片的映射关系永远不变。

- **Redis Cluster**：16384 个 hash slot，`slot = CRC16(key) mod 16384`，每个节点负责一部分 slot。
- Kafka 的 partition、Elasticsearch 的 shard 也是同样的思路，所以它们的分区数都要在一开始规划好。

### 目录（查表）

用一个查找服务记录「这个 key 在哪个分片」。最灵活：可以把一个大租户单独放在一个分片，也可以任意迁移。代价是每次访问多一跳，而且目录服务本身必须高可用。

## 怎么选分片键

一个好的分片键要满足：

1. **基数高、分布均匀**：避免大部分数据集中在少数几个值上。
2. **绝大多数查询都带着它**：查询能直接定位到一个分片，而不需要扫描全部分片。
3. **不是单调递增的**（除非用范围分片并且能自动分裂）。

常见的选择：SaaS 应用按 `tenant_id`（一个租户的所有数据在一起，查询天然带着租户，还顺带实现了数据隔离）；社交应用按 `user_id`。

### 热点 key

即使分布总体均匀，单个 key 也可能特别热：明星的一条微博、一个超大租户。处理办法：

- 给热 key 加随机后缀，拆成多个 key（`post:42#0..9`），写入时打散，读取时汇总；
- 在前面加缓存（见[缓存](/backend/caching)）；
- 用目录式分片，把大租户单独放到专用的分片。

## 跨分片的代价

| 问题 | 原因 | 常见做法 |
|---|---|---|
| 不带分片键的查询 | 要发给所有分片再合并（scatter-gather），延迟取决于最慢的分片 | 尽量让查询带上分片键；需要的话建全局索引 |
| join | 两张表的相关数据可能在不同分片 | 按同一个键对相关表做「共置」分片；反范式 |
| 二级索引 | **本地索引**：每个分片只索引自己的数据，查询要扫所有分片；**全局索引**：按索引键单独分片，查询快，但写入要更新另一个分片上的索引 | 根据读写比例选择 |
| 全局唯一约束 | 唯一性只能在单个分片内保证 | 让唯一键就是分片键；或者用单独的唯一性服务 |
| 全局 id | 各分片的自增 id 会冲突 | 雪花算法（时间戳 + 机器号 + 序列号）、UUIDv7，既唯一又大致有序 |
| 跨分片事务 | 一个事务涉及多台机器 | 见[分布式事务](/stack/ds-txn) |

## 重新平衡

加节点、分片太大或太热时，要迁移数据：

1. 后台把数据从旧分片复制到新分片（全量复制 + 增量追赶）；
2. 短暂地双写，或者追上之后切换路由；
3. 校验无误后删除旧数据。

全程要**限速**，避免迁移流量拖垮线上服务。现成的系统（Vitess、Citus、CockroachDB、TiDB、DynamoDB）会自动完成这些，这也是选用它们的主要理由。

## 实战：AI 应用里的分片

### 向量检索的分片

向量索引很大时也要分片。每个分片上建一个 ANN 索引，查询时**发给所有分片**，各自返回 top-k，再合并出全局的 top-k。代价是查询延迟取决于最慢的分片，并且每个分片都要多返回一些候选，才能保证合并后的召回率。

对多租户的 RAG 来说，**按租户分片（或分区）**一举三得：

1. 一个租户的查询只命中一个分片，不需要 scatter-gather；
2. 天然实现了租户隔离，配合鉴权（见[认证与鉴权](/backend/auth)）；
3. 避开了「HNSW 先找近邻再按租户过滤，小租户召回暴跌」的问题（见 [Embedding 与向量索引](/ai/embedding-vector-index)）。

LLMGateway 的语义缓存其实也做了同样的事：按「alias + system prompt + 历史」算出一个命名空间，每次查找只扫描自己命名空间里的向量。这是一种**按查询局部性分区**的做法。

### Redis Cluster 上的多 key 操作

LLMGateway 的限流在一个 Lua 脚本里同时检查和扣减两个 key：`rl:<key_id>:rpm` 和 `rl:<key_id>:tpm`。在单机 Redis 上没有问题。但 Redis Cluster 要求**一个脚本或事务里涉及的所有 key 必须在同一个 hash slot**，否则直接报 `CROSSSLOT` 错误。这两个 key 名字不同，CRC16 的结果大概率落在不同的 slot。

解决办法是 **hash tag**：key 里花括号括起来的部分才参与 slot 计算，所以写成 `rl:{demo}:rpm` 和 `rl:{demo}:tpm`，就能保证落在同一个 slot。有个细节值得一提：代码里的 key 是用 f-string 拼出来的，花括号是 Python 的插值语法，最终的 key 里并没有花括号。要在 key 里保留一对字面的花括号，需要转义：

```python
keys = [f"rl:{key.id}:rpm", f"rl:{key.id}:tpm"]          # 现状：rl:demo:rpm，不在同一个 slot
keys = [f"rl:{{{key.id}}}:rpm", f"rl:{{{key.id}}}:tpm"]  # 改后：rl:{demo}:rpm，hash tag 生效
```
==把单机代码搬到分片集群上，最先坏掉的往往就是多 key 操作==。语义缓存的 `pipeline(transaction=True)` 同时写三个 key，也是一样的问题。

### DocPilot 的增长路径

DocPilot 目前是单个 PostgreSQL。如果变成多租户、数据量增长：先给表加 `tenant_id`，按租户做表分区；单机撑不住时，用 Citus 这类扩展按 `tenant_id` 做分布式表。文档、chunk、向量都按同一个键共置，入库仍然是单分片上的本地事务，检索也只命中一个分片。

## 追问

::: details 什么时候需要分片？分片之前还有哪些手段？
数据量超过单机容量、写入吞吐超过单个主库、单表大到运维困难时才需要分片。之前可以依次尝试：垂直扩容、读写分离、缓存、归档冷数据、单机内的表分区。分片会让查询、事务、唯一约束、运维都变复杂，所以是最后的手段。
:::

::: details 范围分片和哈希分片各有什么优缺点？
范围分片：范围查询只命中少数分片，天然有序；但单调递增的 key 会让所有写入集中到最后一个分片，形成热点。哈希分片：分布均匀，没有顺序热点；但范围查询要扫所有分片，而且 `hash mod N` 在 N 变化时几乎所有数据都要迁移。
:::

::: details 一致性哈希解决了什么问题？虚拟节点有什么用？
解决 `hash mod N` 在扩缩容时几乎所有 key 都要迁移的问题。key 和节点都映射到一个哈希环上，key 归顺时针遇到的第一个节点；增减一个节点只影响相邻的一段，大约 1/N 的数据要移动。物理节点少时，环上的分布会很不均匀，所以每个物理节点放很多个虚拟节点，让负载更平均，节点下线时它的数据也能分散到多个节点上。
:::

::: details Redis Cluster 怎么分片？为什么多 key 的 Lua 脚本会报 CROSSSLOT 错误？
Redis Cluster 有 16384 个 hash slot，`slot = CRC16(key) mod 16384`，每个节点负责一部分 slot。一个 Lua 脚本、MULTI 事务或多 key 命令涉及的 key 必须在同一个 slot，否则报 CROSSSLOT。解决办法是 hash tag：只有花括号里的部分参与计算，比如 `rl:{demo}:rpm` 和 `rl:{demo}:tpm`。LLMGateway 的限流脚本同时操作两个 key，搬到 Cluster 上就要这样改。
:::

::: details 怎么选分片键？
1. 基数高、分布均匀；
2. 绝大多数查询都带着它，可以直接路由到一个分片；
3. 不是单调递增的；
4. 相关的数据用同一个键，共置在同一个分片上，便于 join 和本地事务。

SaaS 一般用 tenant_id，社交应用一般用 user_id。还要提前想好热点 key（大租户、明星用户）怎么处理。
:::

::: details 分片之后，全局唯一 id 怎么生成？
各分片的自增 id 会冲突。常用雪花算法：64 位里放时间戳、机器号和序列号，单机就能生成，全局唯一并且大致按时间有序（对 B+ 树索引友好）。也可以用 UUIDv7（同样以时间戳开头）。尽量不要用完全随机的 UUIDv4 做主键，它会导致索引页分裂和写放大。
:::

::: details 多租户的向量检索为什么适合按租户分片？
1. 一个租户的查询只命中一个分片，不需要扫所有分片再合并；
2. 天然实现了租户之间的数据隔离；
3. 避开了「近似索引先找全局近邻再按租户过滤，小租户召回暴跌」的问题。

大租户可以单独一个分片，小租户可以多个共享一个分片，这时仍然需要按 tenant_id 过滤。
:::

## 参考

- Martin Kleppmann, *Designing Data-Intensive Applications*，第 6 章（分区）
- Karger et al., [Consistent Hashing and Random Trees](https://www.cs.princeton.edu/courses/archive/fall09/cos518/papers/chash.pdf)
- [Redis Cluster specification（hash slot 与 hash tag）](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- [Vitess](https://vitess.io/docs/)、[Citus: Choosing a distribution column](https://docs.citusdata.com/en/stable/sharding/data_modeling.html)
- [Twitter Snowflake（全局 id）](https://blog.twitter.com/engineering/en_us/a/2010/announcing-snowflake)
- 实战代码：LLMGateway `gateway/limits.py`（多 key Lua 脚本）、`gateway/cache/semantic.py`（命名空间）；DocPilot `schema.sql`
