---
title: Embedding 与向量索引：HNSW、IVF 与 pgvector
status: draft
tags: [embedding, vector-search, hnsw, ivf, pgvector, ann]
difficulty: 3
order: 6
related: [/backend/nosql-fulltext, /backend/sql-index-transaction, /backend/auth, /ai/rag, /ai/prompt-semantic-cache]
stack: [st-vector]
---

# {{ $frontmatter.title }}

## 一句话结论

embedding 模型把一段文本映射成一个几百到几千维的向量，==意思相近的文本，向量距离也近==，于是「语义检索」就变成了「最近邻搜索」。精确的 kNN 要把查询和每一个向量都算一遍距离，是 $O(N \cdot d)$；规模大了就要用 **ANN（近似最近邻）索引**：HNSW（多层图）、IVF（聚类分桶）、PQ（向量压缩），**用一点召回率换数量级的速度提升**。工程上真正容易出问题的不是算法，而是这几件事：距离度量和索引类型要匹配；向量和生成它的模型是绑定的，换模型就要全部重算；带过滤条件的 ANN 召回率可能会暴跌；向量匹配不了精确的词，所以要配合关键词检索一起用。

## 为什么：语义相近要变成可以计算的东西

关键词检索只能匹配字面：用户问「怎么申请休假」，文档里写的是「请假流程」，一个词都对不上。embedding 模型（通常是 transformer 编码器，用对比学习训练）把文本压缩成一个稠密向量，训练目标就是让意思相近的文本在向量空间里靠近。

- **相似度**：最常用余弦相似度 $\cos\theta = \frac{a \cdot b}{\|a\|\|b\|}$。向量先做 L2 归一化之后，余弦相似度就等于点积，计算更快，大多数 embedding API 返回的已经是归一化后的向量。
- **bi-encoder**：查询和文档**分别**编码，文档向量可以离线算好、建索引；而 cross-encoder 把查询和文档**一起**读，更准但不能预先计算，所以用在第二阶段做 rerank（见 [RAG](/stack/ctx-rag)）。
- **维度**：常见的有 384、768、1024、1536、3072。OpenAI 的 `text-embedding-3` 系列用 Matryoshka 方式训练，可以通过 `dimensions` 参数截短向量，用一点精度换更小的存储和更快的检索。DocPilot 用 `text-embedding-3-small`（原生 1536 维）并传 `dimensions=1024`，配合 schema 里的 `vector(1024)`。

## 精确搜索还是近似搜索

先算一笔账：100 万个 1024 维 float32 向量，原始数据 = $10^6 \times 1024 \times 4$ B ≈ **4 GB**。精确搜索一次要做 $10^9$ 次乘加。用 numpy / BLAS 大约几十到几百毫秒，单个查询能接受，高 QPS 就不行了。

==不是所有场景都需要 ANN==。LLMGateway 的语义缓存（`gateway/cache/semantic.py`）每个命名空间只保留最近 2000 条（`max_entries: 2000`），查找就是一次矩阵乘以向量：

```python
matrix = np.frombuffer(b"".join(v for _, v in pairs), dtype=np.float32).reshape(len(pairs), -1)
sims = matrix @ query.astype(np.float32)
best = int(np.argmax(sims))
```

README 的说法是：N=2000 时不到 1 毫秒，代码一眼就能看出是对的；等某个命名空间涨到百万级，再换成 Redis Stack 的 HNSW 或 pgvector。经验上，几万条以内，暴力搜索通常就够了。

## ANN 索引

### HNSW（Hierarchical Navigable Small World）

把向量组织成一个**多层图**：最上层节点很少、边很长，用来快速跳到目标附近；越往下节点越多、边越短，最底层包含所有节点。查询从最上层的入口开始，每一层都贪心地走向离查询更近的邻居，然后下降一层继续。

| 参数 | 作用 | 调大的效果 |
|---|---|---|
| `M` | 每个节点保留多少条边 | 召回率更高，内存更大，建索引更慢 |
| `ef_construction` | 建索引时候选队列的大小 | 图的质量更好，建索引更慢 |
| `ef_search` | 查询时候选队列的大小 | **召回率更高，查询更慢**（在线就能调） |

pgvector 的默认值是 `m = 16`、`ef_construction = 64`、`hnsw.ef_search = 40`。HNSW 的特点：召回率和速度兼顾得最好，支持增量插入；但**内存占用大**（向量之外还要存图），建索引慢，删除需要特殊处理。

### IVF（倒排文件）

先用 k-means 把向量聚成 `lists` 个簇，每个向量归到最近的簇中心。查询时只搜索离查询最近的 `probes` 个簇。

- 建索引快，内存小；
- 需要先有数据才能训练簇中心，数据分布变化后要重建；
- 召回率高度依赖 `probes`：pgvector 的 `ivfflat.probes` 默认是 1，召回率很容易偏低。

### PQ / 量化：压缩向量

- **乘积量化（PQ）**：把向量切成 m 段，每段用一个码本里的编号表示，存储能压缩几十倍，距离计算用查表近似完成，常和 IVF 组合（IVF-PQ，FAISS 的经典方案）。
- **标量量化**：float32 → float16 / int8。pgvector 0.7 起支持 `halfvec`（半精度）和二值量化。
- 常见做法是**用压缩后的向量粗筛，再用原始向量对前几百个候选重新精确排序**。

## pgvector：DocPilot 的用法

```sql
embedding vector(1024) NOT NULL
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
```

```sql
SELECT ..., 1 - (c.embedding <=> %(q)s) AS score
FROM chunks c JOIN documents d ON d.id = c.document_id
ORDER BY c.embedding <=> %(q)s LIMIT %(limit)s
```

- pgvector 有三个距离运算符：`<->`（L2）、`<=>`（余弦距离）、`<#>`（负的内积）。==索引的 operator class 必须和查询用的运算符对应==：建的是 `vector_cosine_ops`，查询就得用 `<=>`，否则不会走索引，悄悄变成全表扫描。
- 余弦**距离** = 1 − 余弦相似度，所以分数用 `1 - distance` 换算回来。
- 向量和文档放在同一个 Postgres 里，可以直接 `JOIN documents` 拿标题，可以按租户过滤，写入也和文档在同一个事务里。这就是「一个 Postgres 装下所有东西」的好处。

### 实战中的三个坑

**1. 零向量。** DocPilot 的离线 `FakeEmbedder`（一个按词哈希的词袋模型）遇到一段全是停用词的文本时，会得到全零向量。零向量的余弦距离没有定义（分母为 0），所以代码把第一维设成 1：

```python
if norm == 0:
    vec[0] = 1.0  # pgvector cosine distance is undefined for the zero vector
```

**2. 向量和模型是绑定的。** 不同模型产生的向量处在不同的空间里，**不能混在一起比较**。DocPilot 的 schema 把维度固定成了 `vector(1024)`：换成维度不同的模型，插入会直接报错，这还算好的；**换成同样输出 1024 维的另一个模型，一切都不会报错，但新旧向量混在一起，检索结果是垃圾**。LLMGateway 的语义缓存做了一半的保护：读取时跳过字节长度和当前查询向量不一致的旧向量（`len(v) == width`），这能挡住维度变化，挡不住同维度的模型更换。稳妥的做法是：每个向量记录生成它的模型名和版本，换模型时建一张新表或新列，后台全部重算后再切换。

**3. 过滤条件和 ANN 的冲突。** 多租户场景要加 `WHERE tenant_id = ?`。HNSW 先按 `ef_search` 找出一批最近邻候选，**然后**才应用过滤条件。如果这个租户只占全部数据的 1%，候选里可能只剩一两条，甚至一条都没有，召回率暴跌，而且不会报任何错。解决方法：

- pgvector 0.8 的 **iterative index scan**：过滤后结果不够，就继续在索引里往下找；
- 按租户**分区**，或者给大租户单独建索引；
- 过滤条件选择性很高时，干脆让查询走普通索引加精确距离计算。

这和[认证与鉴权](/backend/auth)里「多租户 RAG 要在检索 SQL 里按权限过滤」是同一个问题的两面：权限过滤必须做，但做了之后要检查召回率。

## 专用向量数据库还是 pgvector

| | pgvector | 专用向量库（Milvus、Qdrant、Weaviate、Pinecone…） |
|---|---|---|
| 运维 | 复用现有的 Postgres | 多一个系统 |
| 一致性 | 和业务数据在同一个事务里 | 需要同步，存在延迟 |
| 过滤、join | SQL 什么都能做 | 支持过滤，能力因产品而异 |
| 规模和性能 | 千万级以内通常够用 | 亿级、分布式、GPU 加速、更多量化选项 |

==默认从 pgvector 开始==，等规模或性能真的成了瓶颈再迁移。迁移成本主要在 embedding 的同步，而不在查询接口。

## 怎么评估

- **ANN 的召回率**：同一批查询，用精确搜索的结果作为标准答案，算 recall@k。调 `ef_search` / `probes` 时看召回率和延迟的曲线。
- **端到端的检索质量**：有标注的问题集，算 recall@k 和 MRR。DocPilot 的 eval 判断相关性的方法是看 chunk 里是否包含标准答案的原文片段，换一种切分方式标签依然有效，而且能直接跑 vector / fts / hybrid 的对比（见[离线 eval](/stack/ev-offline)）。

## 追问

::: details 余弦相似度和点积有什么关系？为什么很多系统直接用点积？
余弦相似度 = 点积 ÷ 两个向量模长的乘积。向量先做 L2 归一化（模长为 1）之后，余弦相似度就等于点积，省掉了除法。大多数 embedding API 返回的已经是归一化向量，所以直接用点积或者余弦距离都可以，但索引的度量方式必须和查询一致。
:::

::: details 什么时候需要 ANN 索引？什么时候暴力搜索就够了？
暴力搜索是 $O(N \cdot d)$。几万条以内，用 numpy / BLAS 做一次矩阵乘就是亚毫秒到几毫秒，代码简单，召回率 100%。LLMGateway 的语义缓存每个命名空间 2000 条，就是这么做的。百万级以上，或者 QPS 很高时，才需要 HNSW / IVF，用一点召回率换数量级的速度。
:::

::: details HNSW 的 M、ef_construction、ef_search 分别影响什么？
- `M`：每个节点的边数，越大召回率越高，内存越大，建索引越慢。
- `ef_construction`：建索引时的候选队列大小，越大图的质量越好，建索引越慢。
- `ef_search`：查询时的候选队列大小，越大召回率越高，查询越慢，**可以在线调**，是最常用的旋钮。

pgvector 的默认值是 16 / 64 / 40。
:::

::: details HNSW 和 IVF 怎么选？
HNSW：召回率和速度最好，支持增量插入，但内存大、建索引慢。IVF：建索引快、内存小，但要先有数据训练簇中心，数据分布变了要重建，召回率依赖 probes（pgvector 默认 1，很容易偏低）。数据量巨大、内存紧张时，用 IVF-PQ 这类压缩方案。中小规模、要求高召回率时，用 HNSW。
:::

::: details 给向量检索加上 WHERE tenant_id = ? 之后，结果变少甚至为空，为什么？怎么办？
HNSW 先按 ef_search 找出一批最近邻候选，再应用过滤条件。目标租户只占很小比例时，候选里几乎没有符合条件的。解决：pgvector 0.8 的 iterative index scan（不够就继续找）；按租户分区或单独建索引；过滤条件选择性很高时，走普通索引并精确计算距离。上线前要按租户测召回率。
:::

::: details 想把 embedding 模型从 A 换成 B，需要做什么？有什么风险？
不同模型的向量在不同的空间里，不能混用，所以要**全部重新计算**。做法：新建一列或一张表存 B 的向量，后台批量重算，在新索引上跑 eval，确认后切换读路径，最后删掉旧的。

风险：B 和 A 维度相同时，混用不会报任何错，只是结果变成垃圾。所以每个向量都要记录模型名和版本。维度不同时 schema 会报错（DocPilot 的 `vector(1024)`），或者被代码跳过（LLMGateway 按字节长度过滤）。
:::

::: details 估算：1000 万个 1536 维的 float32 向量需要多少内存？怎么降下来？
$10^7 \times 1536 \times 4$ B ≈ 61 GB，HNSW 的图结构还要额外的空间。降低的办法：
1. 用 Matryoshka 模型截短维度（比如 `dimensions=512`，降到约 20 GB）；
2. 半精度 `halfvec` 减半；
3. int8 或二值量化粗筛，再用原始向量重排；
4. IVF-PQ 压缩几十倍。

每一步都要用 eval 确认召回率的损失可以接受。
:::

## 参考

- Malkov & Yashunin, [Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs](https://arxiv.org/abs/1603.09320)
- Jégou et al., [Product Quantization for Nearest Neighbor Search](https://inria.hal.science/inria-00514462/document)
- [pgvector README](https://github.com/pgvector/pgvector)（运算符、HNSW / IVFFlat 参数、iterative index scan、halfvec）
- Kusupati et al., [Matryoshka Representation Learning](https://arxiv.org/abs/2205.13147)
- [OpenAI: Embeddings guide（`dimensions` 参数）](https://platform.openai.com/docs/guides/embeddings)
- [ANN-Benchmarks](https://ann-benchmarks.com/)
- 实战代码：DocPilot `api/src/docpilot/schema.sql`、`retrieval/search.py`（`_vector`）、`embeddings.py`（`FakeEmbedder`）；LLMGateway `gateway/cache/semantic.py`
