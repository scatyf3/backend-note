import type { Card } from '@lib/flashcards'

const R = '/backend/sharding'

export const cards: Card[] = [
  {
    id: 'shard-when',
    deck: 'backend',
    topic: '分片',
    q: '什么时候才需要分片？在分片之前还有哪些更便宜的手段？',
    a: '复制只能扩展读和可用性，**每个副本仍是全量数据，写入仍经过主库**。当数据量超过单机、写吞吐超过单个主库、单表大到运维困难时，才需要分片。\n之前可以依次尝试：垂直扩容 → 读写分离 → 缓存 → 归档冷数据 → **单机内的表分区**（PostgreSQL 声明式分区）。\n分片会让查询、事务、唯一约束、运维都变复杂，是最后的手段。',
    ref: `${R}#为什么、以及什么时候才分片`,
  },
  {
    id: 'shard-range-vs-hash',
    deck: 'backend',
    topic: '分片策略',
    q: '范围分片和哈希分片各有什么优缺点？为什么 `hash(key) mod N` 不适合需要扩容的系统？',
    a: '- **范围分片**：范围查询只命中少数分片、天然有序；但**单调递增的 key**（自增 id、时间戳）会让新写入全部落在最后一个分片，形成热点。\n- **哈希分片**：分布均匀；但范围查询要扫所有分片。\n`mod N`：N 从 4 变成 5，几乎所有 key 的结果都变了，大约 **N/(N+1)** 的数据要迁移。所以要用一致性哈希或固定数量的逻辑分片。',
    ref: `${R}#分片策略`,
  },
  {
    id: 'shard-consistent-hash',
    deck: 'backend',
    topic: '一致性哈希',
    q: '一致性哈希怎么减少扩容时的数据迁移？虚拟节点起什么作用？',
    a: 'key 和节点都映射到一个**哈希环**上，key 归顺时针方向遇到的第一个节点。增加一个节点，只有它接管的那一段 key 要移动，大约 **1/N**。\n**虚拟节点**：物理节点少时，环上的分布很不均匀。每个物理节点放很多个虚拟节点，负载更平均；某个节点下线时，它的数据也能分散到多个节点上，而不是全压给一个邻居。',
    ref: `${R}#一致性哈希和逻辑分片`,
  },
  {
    id: 'shard-logical-slots',
    deck: 'backend',
    topic: '逻辑分片',
    q: '「固定数量的逻辑分片」是什么思路？Redis Cluster 是怎么做的？',
    a: '一开始就把数据切成**远多于节点数**的逻辑分片，再把逻辑分片分配给节点。扩容时**整块迁移逻辑分片**，key 到逻辑分片的映射永远不变。\nRedis Cluster：**16384 个 hash slot**，`slot = CRC16(key) mod 16384`，每个节点负责一部分 slot，扩容就是迁移 slot。\nKafka 的 partition、Elasticsearch 的 shard 也是这个思路，所以分区数要在一开始规划好。',
    ref: `${R}#一致性哈希和逻辑分片`,
  },
  {
    id: 'shard-key-choice',
    deck: 'backend',
    topic: '分片键',
    q: '怎么选一个好的分片键？热点 key 怎么处理？',
    a: '**好的分片键**：1. 基数高、分布均匀；2. **绝大多数查询都带着它**，能直接路由到一个分片；3. 不单调递增；4. 相关数据用同一个键共置，便于 join 和本地事务。SaaS 常用 `tenant_id`，社交常用 `user_id`。\n**热点 key**（明星用户、超大租户）：加随机后缀拆成多个 key 打散写入；前面加缓存；用目录式分片把大租户单独放到专用分片。',
    ref: `${R}#怎么选分片键`,
  },
  {
    id: 'shard-cross-costs',
    deck: 'backend',
    topic: '跨分片',
    q: '分片之后，二级索引有「本地索引」和「全局索引」两种做法，各有什么取舍？全局 id 怎么生成？',
    a: '- **本地索引**：每个分片只索引自己的数据，写入简单；但按索引查询要**扫所有分片**再合并（scatter-gather）。\n- **全局索引**：按索引键单独分片，查询只命中一个分片；但写入要**跨分片更新索引**，通常是异步的、最终一致的。\n**全局 id**：各分片的自增 id 会冲突，用**雪花算法**（时间戳 + 机器号 + 序列号）或 **UUIDv7**，既唯一又大致有序，对 B+ 树友好。',
    ref: `${R}#跨分片的代价`,
  },
  {
    id: 'shard-redis-crossslot',
    deck: 'backend',
    topic: 'Redis Cluster',
    q: 'LLMGateway 的限流 Lua 脚本同时操作 `rl:<id>:rpm` 和 `rl:<id>:tpm` 两个 key。搬到 Redis Cluster 上会出什么问题？怎么修？',
    a: 'Redis Cluster 要求**一个 Lua 脚本 / MULTI 事务里的所有 key 都在同一个 hash slot**。两个不同名的 key，CRC16 后大概率落在不同的 slot，会直接报 **CROSSSLOT** 错误。\n修法：**hash tag**，只有花括号里的部分参与 slot 计算，写成 `rl:{demo}:rpm` 和 `rl:{demo}:tpm`。\n细节：代码是用 f-string 拼 key 的，花括号会被当成插值，要转义（三层花括号）才能在 key 里留下字面的 `{}`。语义缓存的多 key 事务也有同样的问题。',
    ref: `${R}#redis-cluster-上的多-key-操作`,
  },
  {
    id: 'shard-vector-tenant',
    deck: 'backend',
    topic: 'AI 场景',
    q: '向量检索分片后怎么查询？为什么多租户 RAG 适合按租户分片？',
    a: '**查询**：每个分片各建 ANN 索引，查询**发给所有分片**，各自返回 top-k，再合并出全局 top-k。延迟取决于最慢的分片，每个分片还要多返回一些候选来保证召回。\n**按租户分片的好处**：\n1. 一个租户的查询只命中**一个分片**，不需要 scatter-gather；\n2. 天然的**租户隔离**；\n3. 避开「HNSW 先找全局近邻再按租户过滤，小租户召回暴跌」的问题。\nLLMGateway 的语义缓存按命名空间分区，也是同样的思路。',
    ref: `${R}#向量检索的分片`,
  },
]
