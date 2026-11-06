---
title: NoSQL 与全文检索：LSM 树、数据模型与倒排索引
status: draft
tags: [nosql, lsm, dynamodb, cassandra, full-text, bm25, postgres]
difficulty: 3
order: 10
related: [/backend/sql-index-transaction, /backend/caching, /ai/embedding-vector-index, /ai/rag, /ai/tokens-context-window]
stack: [st-nosql]
---

# {{ $frontmatter.title }}

## 一句话结论

NoSQL 不是「不用 SQL」，而是==放弃关系模型的一部分通用性（任意 join、跨行事务、随意的查询），换取某些固定访问模式下的水平扩展能力和写吞吐==。存储引擎层面的核心分歧是 **B+ 树**（为读优化，原地更新）和 **LSM 树**（为写优化，只追加写，后台合并）。全文检索靠**倒排索引**加 **BM25** 排序：PostgreSQL 自带的全文检索够中小规模用，大规模和复杂的相关性调优用 Elasticsearch / OpenSearch。AI 时代，全文检索并没有被向量检索取代，反而成了混合检索里**不可缺少的一半**：错误码、产品名、端口号这类精确的词，向量很难匹配上。

## 为什么会有 NoSQL

关系数据库单机很强，但在两个方向上会碰到天花板：

1. **写入量超过单机**：分片之后，跨分片的 join 和事务又慢又复杂（见[分片](/stack/ds-sharding)）。
2. **schema 和访问模式**：有些数据天然是一个文档（一份订单连同它的条目）或者一串时间序列，硬拆成多张表反而别扭。

于是出现了一类系统：**一开始就按「数据会分布在很多节点上」来设计**，只支持那些能在单个分区内高效完成的操作。代价是：你必须**先想清楚访问模式，再设计数据模型**，而不是像关系库那样先建模、以后随便查。

## 存储引擎：B+ 树和 LSM 树

### LSM 树怎么写

```
写入 → WAL（保证持久性）+ memtable（内存里的有序结构）
memtable 写满 → 整体刷成磁盘上一个不可变的、有序的 SSTable
后台 compaction → 把多个 SSTable 合并，丢掉被覆盖和删除的旧值
```

所有写入都是**顺序写**，不需要原地更新，所以写吞吐很高。RocksDB、LevelDB、Cassandra、HBase、ScyllaDB 都用 LSM。

### 怎么读

一个 key 可能出现在 memtable 和好几层 SSTable 里，要从新到旧依次查。为了不让每次读都扫所有文件：

- 每个 SSTable 带一个**布隆过滤器**，「肯定不在这个文件里」就直接跳过；
- 每个 SSTable 有稀疏索引，文件内部用二分查找；
- compaction 控制文件的数量。

### 三种放大的权衡

| | B+ 树 | LSM 树 |
|---|---|---|
| 写放大 | 改一行要重写整页，加上 WAL | compaction 会让同一份数据被反复重写 |
| 读放大 | 低：一条从根到叶的路径 | 高：可能要查多层文件，靠布隆过滤器缓解 |
| 空间放大 | 页内有碎片 | 旧版本在 compaction 之前一直占着空间 |
| 适合 | 读多写少、要求读延迟稳定 | 写多、需要高吞吐写入 |

compaction 策略本身也是权衡：**size-tiered** 写放大小、空间放大大；**leveled** 读放大和空间放大小、写放大大。==读、写、空间三种放大不可能同时最小==（RUM 猜想）。

## 四类 NoSQL

| 类型 | 代表 | 数据模型 | 适合 |
|---|---|---|---|
| KV | Redis、DynamoDB、etcd | key → value | 缓存、会话、配置、按主键访问 |
| 文档 | MongoDB、Couchbase | key → JSON 文档 | 自包含的实体（用户资料、商品），schema 经常变化 |
| 宽列 | Cassandra、HBase、Bigtable | 分区键 + 排序键 → 很多列 | 时间序列、日志、海量写入 |
| 图 | Neo4j | 节点 + 边 | 社交关系、多跳查询 |

### 按访问模式建模：以 DynamoDB 为例

- 每个查询都要能被**一个分区键（加上排序键的范围）**直接定位。「查某用户最近 20 条订单」：分区键是 `user_id`，排序键是 `order_time`。
- **反范式**：把一起读的东西放在一起，宁可冗余，也不做 join。
- 需要第二种访问模式，就建一个**二级索引**（GSI），它本质上是数据换了一个分区键的另一份副本。
- **热分区**：所有写入落在同一个分区键上（比如以「日期」做分区键），吞吐就被限制在单个分区的上限。分区键要有足够的基数，分布要均匀。

### 一致性是可调的

Dynamo 风格的系统（Cassandra、早期的 DynamoDB）有 N 个副本，写 W 个、读 R 个，满足 $R + W > N$ 时，读一定能看到最新的写入。调低 R 或 W 换取延迟，就要接受可能读到旧数据。细节见[复制与一致性](/stack/ds-replication)。

### 什么时候不用 NoSQL

==默认先用 PostgreSQL==：JSONB 能存文档，GIN 索引能做全文检索，pgvector 能做向量检索，事务和 join 都还在。DocPilot 的 README 里有一条设计原则就是「一个 Postgres 装下所有东西」：文档、chunk、全文索引、向量、会话和 trace，少一个系统就少一份运维负担和一致性问题。等到写入量、数据量、可用性需求真的超出单机关系库的能力，并且访问模式已经稳定，再考虑 NoSQL。

## 全文检索

### 倒排索引

正排是「文档 → 它包含的词」，倒排是「**词 → 包含它的文档列表**」（posting list，通常还带有词在文档里出现的位置）。

```
"shard"  → [doc3: pos 12, 40], [doc7: pos 5]
"region" → [doc3: pos 13], [doc9: pos 2]
```

查询 `shard AND region` 就是求两个 posting list 的交集；短语查询「shard region」还要检查位置是否相邻。

建索引之前，文本要先经过 **analyzer** 处理：分词 → 小写化 → 去停用词 → 词干化（`running` → `run`）。==analyzer 决定了「什么算同一个词」==，而且查询和建索引必须用同一个 analyzer。中文没有空格，需要专门的分词器（jieba、IK、zhparser）或者 n-gram。

### 排序：从 TF-IDF 到 BM25

- **TF**（词频）：词在这篇文档里出现得越多，越相关。
- **IDF**（逆文档频率）：词在整个语料里越少见，区分度越高。「the」几乎没用，「pgvector」很有用。
- **BM25** 在 TF-IDF 的基础上加了两项修正：
  - **TF 饱和**（参数 $k_1$）：出现 10 次不应该是出现 1 次的 10 倍相关；
  - **长度归一化**（参数 $b$）：长文档天然包含更多词，要打折扣。

BM25 是现在全文检索的默认排序算法（Lucene、Elasticsearch 都在用）。

### PostgreSQL 全文检索：DocPilot 的用法

```sql
tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);
```

- **生成列**：插入或更新 `text` 时自动计算 `tsvector`，应用代码不用管，也不会忘记更新。
- **GIN 索引**：PostgreSQL 的倒排索引。
- **排序**用 `ts_rank_cd`（cover density，考虑匹配词之间的距离）。

DocPilot 的 `retrieval/search.py` 里有一个实际踩到的坑：

```python
def fts_query(question: str) -> str:
    """OR the words together: plainto_tsquery ANDs them, which misses most natural questions."""
    words = re.findall(r"[A-Za-z0-9]+", question)
    return " | ".join(words)
```

`plainto_tsquery` 把所有词用 **AND** 连起来。自然语言的问题（「Beacon 在哪个端口终止 TLS？」）里很多词不会全部出现在同一个 chunk 里，AND 之后经常一个结果都没有。改成 **OR** 之后，召回率上来了，排序交给 `ts_rank_cd`。停用词由 `english` 配置自动去掉。

这段代码还有两个局限，值得在面试里主动提：

1. **`ts_rank` / `ts_rank_cd` 不是 BM25**：它们只看词频和词之间的距离，**不使用整个语料的 IDF**。常见词和罕见词的权重一样，相关性排序比 Elasticsearch 弱。需要 BM25 的话，可以用 ParadeDB 的 `pg_search` 这类扩展，或者外接搜索引擎。
2. **只认 ASCII 字母和数字**：正则 `[A-Za-z0-9]+` 会把中文问题里的字全部丢掉，生成一个空查询，代码直接返回空列表。再加上 `english` 配置不做中文分词，**中文文档的全文检索这一路实际上是关着的**，混合检索退化成纯向量检索。这和 [Token 与上下文窗口](/ai/tokens-context-window)里切分器按空格数词的问题是同一类问题：英文的假设被写死在了代码里。

### 为什么向量检索时代还需要全文检索

向量擅长「意思相近」，但对**精确的字符串**很差：错误码 `E1047`、端口号 `8443`、产品名、人名、版本号。这些在 embedding 空间里没有特别的含义，换一个相近的数字，向量几乎一样。BM25 正好相反。所以 RAG 的主流做法是**混合检索**：两路各取候选，再用 RRF 融合（见 [RAG](/stack/ctx-rag)、[Embedding 与向量索引](/stack/st-vector)）。DocPilot 的 eval 能直接跑 `vector` / `fts` / `hybrid` 三种模式的对比，用数据说明两路各自的贡献。

## 追问

::: details B+ 树和 LSM 树有什么区别？各适合什么负载？
B+ 树原地更新，读一条从根到叶的路径，读延迟低且稳定，但随机写多，写放大大（改一行要重写整页）。LSM 树只追加：先写 WAL 和 memtable，满了刷成不可变的 SSTable，后台 compaction 合并。全是顺序写，写吞吐高，但读要查多层文件（靠布隆过滤器缓解），compaction 还会占 IO 并带来写放大。读多写少用 B+ 树（关系库），写多用 LSM 树（Cassandra、RocksDB、时序数据）。
:::

::: details 什么时候应该选 NoSQL 而不是 PostgreSQL？
满足以下条件时：写入量或数据量超出单机关系库能力，需要水平扩展；访问模式固定，能用分区键直接定位；可以接受没有跨分区事务和 join；或者需要多区域多活、可调的一致性。否则默认用 PostgreSQL，JSONB、GIN 全文检索、pgvector 能覆盖大部分需求，而且少一个系统就少一份一致性问题。
:::

::: details DynamoDB 或 Cassandra 的数据模型怎么设计？什么是热分区？
从访问模式出发：每个查询都要能被一个分区键（加上排序键的范围）直接定位，一起读的数据放在一起，接受冗余（反范式），需要别的访问模式就建二级索引。热分区是大量请求集中在同一个分区键上（比如用日期做分区键，当天的写入全落在一个分区），吞吐被单个分区的上限卡住。分区键要高基数、分布均匀，必要时加随机后缀打散。
:::

::: details 什么是倒排索引？BM25 相比 TF-IDF 改进了什么？
倒排索引是「词 → 包含它的文档列表（带位置）」，查询就是对 posting list 求交集或并集，短语查询再检查位置。BM25 在 TF-IDF 的基础上加了 TF 饱和（参数 $k_1$，词出现很多次之后收益递减）和文档长度归一化（参数 $b$，长文档打折扣），是 Lucene / Elasticsearch 的默认排序算法。
:::

::: details DocPilot 为什么不用 plainto_tsquery，而要自己把词用 OR 连起来？
`plainto_tsquery` 把所有词用 AND 连接，要求一个 chunk 包含问题里的每一个词。自然语言问题很少能全部命中，结果经常是空的。改成 OR 之后，只要包含部分词就能被召回，再由 `ts_rank_cd` 排序。代价是噪音变多，好在混合检索里还有向量这一路和 RRF 融合来平衡。
:::

::: details PostgreSQL 自带的全文检索有哪些局限？
1. `ts_rank` / `ts_rank_cd` 不使用语料级别的 IDF，不是 BM25，相关性比 Elasticsearch 弱；
2. 内置配置不支持中文分词，要装 zhparser 之类的扩展或用 n-gram；
3. 没有 Elasticsearch 那样的同义词、模糊匹配、聚合和相关性调优能力；
4. 数据量很大时，GIN 索引的更新成本和查询性能不如专门的搜索引擎。

DocPilot 的查询构造还只保留 ASCII 字母数字，中文问题会变成空查询。
:::

::: details 有了向量检索，为什么 RAG 还要保留关键词检索？
向量擅长语义相近，但对精确字符串很差：错误码、端口号、产品名、版本号在 embedding 里没有特殊含义，相近的数字向量几乎一样。BM25 对精确匹配很强，但不懂同义和改写。两者互补，所以用混合检索加 RRF 融合。DocPilot 的 eval 支持 vector / fts / hybrid 三种模式的对比，可以量化两路各自的贡献。
:::

## 参考

- Martin Kleppmann, *Designing Data-Intensive Applications*，第 3 章（SSTable、LSM 树、B 树）
- O'Neil et al., [The Log-Structured Merge-Tree](https://www.cs.umb.edu/~poneil/lsmtree.pdf)
- DeCandia et al., [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)
- [AWS: Best practices for designing and architecting with DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html)
- Robertson & Zaragoza, [The Probabilistic Relevance Framework: BM25 and Beyond](https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf)
- [PostgreSQL: Full Text Search](https://www.postgresql.org/docs/current/textsearch.html)（`plainto_tsquery`、`ts_rank_cd`、GIN）
- 实战代码：DocPilot `api/src/docpilot/schema.sql`（生成列 + GIN）、`retrieval/search.py`（`fts_query`、`_fts`）
