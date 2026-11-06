---
title: NoSQL 与全文检索
---

# NoSQL 与全文检索

这一格讲两件事。一是 NoSQL：放弃关系模型的部分通用性（任意 join、跨行事务），换取固定访问模式下的水平扩展和写吞吐。存储引擎的核心分歧是 B+ 树（读优化）和 LSM 树（写优化：WAL + memtable + 不可变 SSTable + compaction），读、写、空间三种放大不可能同时最小。二是全文检索：倒排索引加 BM25 排序。默认先用 PostgreSQL（JSONB、GIN、pgvector），访问模式稳定且超出单机能力时再上 NoSQL。

- **按访问模式建模**：分区键要高基数，避免热分区；需要别的访问模式就建二级索引（数据的另一份副本）。
- **`plainto_tsquery` 是 AND**，自然语言问题经常查不到，DocPilot 改成 OR；`ts_rank` 不用 IDF，不是 BM25。
- **向量时代仍然需要关键词检索**：错误码、端口号、产品名这类精确字符串靠 BM25，混合检索两路互补。

笔记：[NoSQL 与全文检索](/backend/nosql-fulltext)

**延伸阅读**：[Dynamo 论文](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)、[PostgreSQL: Full Text Search](https://www.postgresql.org/docs/current/textsearch.html)
