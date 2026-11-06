import type { Card } from '@lib/flashcards'

const R = '/backend/nosql-fulltext'

export const cards: Card[] = [
  {
    id: 'nosql-lsm-vs-btree',
    deck: 'backend',
    topic: '存储引擎',
    q: 'LSM 树的写入和读取流程是什么？它和 B+ 树在读、写、空间三种放大上怎么取舍？',
    a: '**写**：WAL + memtable（内存有序结构）→ 满了整体刷成**不可变的有序 SSTable** → 后台 **compaction** 合并、丢弃旧值。全是顺序写，写吞吐高。\n**读**：从 memtable 到各层 SSTable 由新到旧查找，靠每个文件的**布隆过滤器**跳过不含该 key 的文件。\n**权衡**：B+ 树读放大低、写放大高（改一行重写整页）；LSM 写入便宜，但读放大高，compaction 带来写放大，旧版本带来空间放大。三者不可能同时最小（RUM）。',
    ref: `${R}#存储引擎-b-树和-lsm-树`,
  },
  {
    id: 'nosql-when',
    deck: 'backend',
    topic: '选型',
    q: '什么时候应该选 NoSQL，而不是继续用 PostgreSQL？',
    a: '同时满足这些条件时：\n1. 写入量或数据量**超出单机关系库**，需要水平扩展；\n2. **访问模式固定**，每个查询都能用分区键直接定位；\n3. 能接受没有跨分区事务和 join；\n4. 或者需要多区域多活、可调一致性。\n否则**默认 PostgreSQL**：JSONB 存文档、GIN 做全文检索、pgvector 做向量检索。DocPilot 把所有数据放在一个 Postgres 里，少一个系统就少一份一致性问题。',
    ref: `${R}#什么时候不用-nosql`,
  },
  {
    id: 'nosql-dynamo-modeling',
    deck: 'backend',
    topic: '数据模型',
    q: '在 DynamoDB / Cassandra 里怎么为「查某用户最近 20 条订单」建模？什么是热分区？',
    a: '**建模**：分区键 = `user_id`，排序键 = `order_time`，一次查询定位到一个分区，再按排序键范围倒序取 20 条。原则：**先列出访问模式，再设计数据模型**；一起读的数据放在一起（反范式）；需要其他访问模式就建 GSI（本质上是换了分区键的另一份副本）。\n**热分区**：大量请求集中在同一个分区键上（比如用日期做分区键），吞吐被单个分区的上限卡住。分区键要高基数、分布均匀，必要时加随机后缀打散。',
    ref: `${R}#按访问模式建模-以-dynamodb-为例`,
  },
  {
    id: 'nosql-inverted-index',
    deck: 'backend',
    topic: '全文检索',
    q: '倒排索引是什么结构？analyzer 起什么作用，为什么建索引和查询必须用同一个？',
    a: '倒排索引是 **词 → 包含它的文档列表（带位置）**（posting list）。AND 查询求交集，OR 求并集，短语查询再检查位置是否相邻。\n**analyzer** 把文本变成词：分词 → 小写化 → 去停用词 → 词干化（running → run）。它决定了**什么算同一个词**。建索引和查询的 analyzer 不一致，同一个词会被处理成不同的形式，永远匹配不上。中文需要专门的分词器（jieba、IK、zhparser）或 n-gram。',
    ref: `${R}#倒排索引`,
  },
  {
    id: 'nosql-bm25',
    deck: 'backend',
    topic: '全文检索',
    q: 'BM25 相比 TF-IDF 做了哪两项改进？',
    a: 'TF-IDF：词在文档里出现越多（TF）、在语料里越少见（IDF），得分越高。\nBM25 加了两项修正：\n1. **TF 饱和**（参数 $k_1$）：出现 10 次不该是出现 1 次的 10 倍相关，收益递减；\n2. **文档长度归一化**（参数 $b$）：长文档天然包含更多词，要打折扣。\nBM25 是 Lucene / Elasticsearch 的默认排序算法。',
    ref: `${R}#排序-从-tf-idf-到-bm25`,
  },
  {
    id: 'nosql-plainto-and',
    deck: 'backend',
    topic: 'PostgreSQL FTS',
    q: 'DocPilot 为什么不用 `plainto_tsquery`，而是自己把问题里的词用 ` | ` 连起来交给 `to_tsquery`？',
    a: '`plainto_tsquery` 把所有词用 **AND** 连接，要求一个 chunk 包含问题里的每一个词。自然语言问题的词很少能全部出现在同一个 chunk 里，结果经常为空。\n改成 **OR** 后，包含部分词就能被召回，再由 `ts_rank_cd` 排序；停用词由 `english` 配置自动去掉。\n代价是噪音变多，由混合检索中的向量一路和 RRF 融合来平衡。',
    ref: `${R}#postgresql-全文检索-docpilot-的用法`,
  },
  {
    id: 'nosql-pg-fts-limits',
    deck: 'backend',
    topic: 'PostgreSQL FTS',
    q: 'DocPilot 的 PostgreSQL 全文检索有哪两个局限？对中文文档意味着什么？',
    a: '1. **`ts_rank` / `ts_rank_cd` 不是 BM25**：只看词频和词间距离，**不使用语料级 IDF**，常见词和罕见词权重一样。需要 BM25 可以用 ParadeDB `pg_search` 或外接 Elasticsearch。\n2. **查询构造只保留 `[A-Za-z0-9]+`**，`english` 配置也不做中文分词。中文问题会变成**空查询**，代码直接返回空列表。\n所以中文文档的全文检索这一路实际上是关着的，混合检索**退化成纯向量**，而且不会报任何错。',
    ref: `${R}#postgresql-全文检索-docpilot-的用法`,
  },
  {
    id: 'nosql-why-keep-keyword',
    deck: 'backend',
    topic: '混合检索',
    q: '已经有了向量检索，为什么 RAG 还要保留关键词检索？',
    a: '向量擅长**语义相近**，但对**精确字符串**很差：错误码 `E1047`、端口号 `8443`、产品名、版本号在 embedding 空间里没有特殊含义，相近的数字向量几乎一样。\nBM25 正好相反：精确匹配很强，但不懂同义和改写。\n所以用**混合检索**：两路各取候选，再用 RRF 融合。DocPilot 的 eval 能跑 vector / fts / hybrid 三种模式的对比，量化两路各自的贡献。',
    ref: `${R}#为什么向量检索时代还需要全文检索`,
  },
]
