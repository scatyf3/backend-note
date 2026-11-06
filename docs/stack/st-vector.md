---
title: Embedding 与向量索引
---

# Embedding 与向量索引

这一格把「意思相近」变成可以查询的东西：embedding 模型把文本映射成向量，语义检索就是最近邻搜索。精确 kNN 是 $O(N \cdot d)$，规模大了用 ANN 索引：HNSW（多层图，召回率高但吃内存）、IVF（聚类分桶，省内存但依赖 probes）、PQ / 量化（压缩向量），都是用一点召回率换数量级的速度。工程上的坑多在算法之外：索引的距离度量要和查询运算符匹配，向量和模型绑定，带过滤条件时召回率可能暴跌。

- **几万条以内暴力搜索就够**：LLMGateway 的语义缓存每个命名空间 2000 条，用一次 numpy 矩阵乘，不到 1 毫秒。
- **换模型必须全量重算**：同维度的模型混用不会报错，只会出垃圾结果，所以要给每个向量记录模型版本。
- **HNSW + WHERE 是先找近邻再过滤**，小租户可能召回为空；pgvector 0.8 的 iterative scan 或按租户分区可以解决。

笔记：[Embedding 与向量索引](/ai/embedding-vector-index)

**延伸阅读**：[HNSW 论文](https://arxiv.org/abs/1603.09320)、[pgvector README](https://github.com/pgvector/pgvector)
