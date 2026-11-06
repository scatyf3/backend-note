---
title: RAG：切分、检索与重排
---

# RAG：切分、检索与重排

RAG 先检索、再生成：从知识库里找出相关片段放进上下文，让模型据此回答并给出引用。相比微调，它能随时更新知识、给出来源、按权限过滤；相比把所有内容塞进长上下文，它更便宜，效果也更好。质量瓶颈通常在检索：切分方式、向量和关键词混合检索、RRF 融合（只用排名，k = 60）、cross-encoder 只对头部候选重排，每一环都要用 recall@k 和 MRR 量化。agentic RAG 让模型自己决定搜几次，能处理多跳问题，代价是更高的延迟和成本。

- **按标题切分，加重叠**：重叠 O 个词时，任何不超过 O+1 个词的片段都完整地落在某个窗口里（DocPilot `chunk.py`）。
- **检索和生成分开评估**：DocPilot 用「chunk 是否包含标准答案的原文片段」判断相关性，换切分方式标签也不会失效。
- **常见失败**：词汇不匹配、事实被切断、索引过时、没按权限过滤、文档里的注入。

笔记：[RAG：切分、混合检索、融合与重排](/ai/rag)

**延伸阅读**：[RRF 原论文](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)、[Anthropic: Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)
