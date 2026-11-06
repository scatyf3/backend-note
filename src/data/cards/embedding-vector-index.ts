import type { Card } from '@lib/flashcards'

const R = '/ai/embedding-vector-index'

export const cards: Card[] = [
  {
    id: 'vec-cos-dot',
    deck: 'ai',
    topic: '相似度',
    q: '余弦相似度和点积是什么关系？为什么很多向量检索系统直接用点积？',
    a: '$\\cos\\theta = \\frac{a \\cdot b}{\\|a\\|\\|b\\|}$。向量先做 **L2 归一化**（模长为 1）之后，余弦相似度**就等于点积**，省掉了除法。\n大多数 embedding API 返回的已经是归一化向量。注意：**索引的度量方式必须和查询一致**。pgvector 里 `vector_cosine_ops` 的索引只服务 `<=>` 运算符，用错了会悄悄变成全表扫描。',
    ref: `${R}#为什么-语义相近要变成可以计算的东西`,
  },
  {
    id: 'vec-brute-force-enough',
    deck: 'ai',
    topic: 'ANN',
    q: '什么时候暴力向量搜索就够了，不需要 ANN 索引？举一个实际的例子。',
    a: '暴力搜索是 $O(N \\cdot d)$。**几万条以内**，numpy / BLAS 做一次矩阵乘就是亚毫秒到几毫秒，代码简单，召回率 100%。\n例子：LLMGateway 的语义缓存每个命名空间只保留最近 **2000** 条，查找就是 `matrix @ query` 再取 `argmax`，不到 1 毫秒，代码一眼就能看出是对的。命名空间涨到百万级时，再换成 Redis Stack 的 HNSW 或 pgvector。',
    ref: `${R}#精确搜索还是近似搜索`,
  },
  {
    id: 'vec-hnsw-params',
    deck: 'ai',
    topic: 'HNSW',
    q: 'HNSW 的 M、ef_construction、ef_search 分别影响什么？线上想提高召回率，先调哪个？',
    a: '- **M**：每个节点的边数。越大召回率越高，内存越大，建索引越慢。\n- **ef_construction**：建索引时的候选队列大小。越大图质量越好，建索引越慢。\n- **ef_search**：查询时的候选队列大小。越大召回率越高、查询越慢，**可以在线调**。\n线上先调 **ef_search**，不用重建索引。pgvector 的默认值是 m = 16、ef_construction = 64、ef_search = 40。',
    ref: `${R}#hnsw-hierarchical-navigable-small-world`,
  },
  {
    id: 'vec-hnsw-vs-ivf',
    deck: 'ai',
    topic: 'ANN',
    q: 'HNSW 和 IVF 各有什么优缺点？怎么选？',
    a: '- **HNSW**（多层图）：召回率和速度最好，支持增量插入；但**内存大**（要存图），建索引慢。\n- **IVF**（k-means 分桶，查最近的 probes 个桶）：建索引快、内存小；但要**先有数据训练簇中心**，数据分布变了要重建，召回率依赖 probes（pgvector 的 `ivfflat.probes` 默认是 1，很容易偏低）。\n中小规模、要求高召回率用 HNSW；数据巨大、内存紧张用 IVF-PQ 这类压缩方案。',
    ref: `${R}#ann-索引`,
  },
  {
    id: 'vec-filter-recall',
    deck: 'ai',
    topic: '过滤',
    q: '给 HNSW 向量检索加上 `WHERE tenant_id = ?` 后，小租户的结果变少甚至为空。为什么？怎么解决？',
    a: 'HNSW **先**按 `ef_search` 找出一批全局最近邻候选，**再**应用过滤条件。目标租户只占 1% 的数据时，候选里几乎没有它的数据，召回率暴跌，而且**不报任何错**。\n解决：\n1. pgvector 0.8 的 **iterative index scan**：过滤后不够就继续找；\n2. **按租户分区**，或给大租户单独建索引；\n3. 过滤条件选择性很高时，走普通索引并精确计算距离。\n上线前要**按租户测召回率**。',
    ref: `${R}#实战中的三个坑`,
  },
  {
    id: 'vec-model-bound',
    deck: 'ai',
    topic: '运维',
    q: '把 embedding 模型从 A 换成 B，为什么必须全量重算？哪种情况最危险？',
    a: '不同模型的向量处在**不同的空间**里，混在一起比较没有意义。\n**最危险的是 B 和 A 维度相同**：插入和查询都不会报错，只是检索结果变成垃圾。维度不同时，schema 会报错（DocPilot 的 `vector(1024)`），或者被代码跳过（LLMGateway 的语义缓存按字节长度过滤）。\n做法：**每个向量记录模型名和版本**；新建列或表，后台重算，跑 eval 确认后切换读路径，再删旧数据。',
    ref: `${R}#实战中的三个坑`,
  },
  {
    id: 'vec-zero-vector',
    deck: 'ai',
    topic: 'pgvector',
    q: 'DocPilot 的 FakeEmbedder 遇到全是停用词的文本时，为什么要把第一维设成 1？',
    a: '全是停用词的文本经过哈希词袋后是**全零向量**。余弦距离 $= 1 - \\frac{a \\cdot b}{\\|a\\|\\|b\\|}$，零向量的模长是 0，**分母为 0，余弦距离没有定义**，pgvector 计算时会出问题。\n把第一维设成 1，就得到一个合法的单位向量。顺带一点：这个哈希词袋 embedder 是**词汇级**的，不是语义级的，只能用作离线测试和 ablation 基线。',
    ref: `${R}#实战中的三个坑`,
  },
  {
    id: 'vec-memory-estimate',
    deck: 'ai',
    topic: '估算',
    q: '估算 1000 万个 1536 维 float32 向量的原始存储大小。有哪些办法降下来？',
    a: '$10^7 \\times 1536 \\times 4\\ \\text{B} \\approx 61\\ \\text{GB}$，HNSW 的图结构还要额外空间。\n降低办法：\n1. **Matryoshka 截短维度**（`dimensions=512`，约 20 GB；DocPilot 用 1536 → 1024）；\n2. **halfvec** 半精度，减半；\n3. **int8 / 二值量化**粗筛，再用原始向量重排；\n4. **IVF-PQ** 压缩几十倍。\n每一步都要用 eval 确认召回率的损失可以接受。',
    ref: `${R}#pq-量化-压缩向量`,
  },
]
