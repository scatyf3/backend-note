---
title: RAG：切分、混合检索、融合与重排
status: draft
tags: [rag, retrieval, chunking, rrf, rerank, agentic-rag]
difficulty: 4
order: 10
related: [/ai/embedding-vector-index, /backend/nosql-fulltext, /ai/prompt-versioning, /ai/tokens-context-window, /ai/offline-evals, /backend/auth, /ai/prompt-injection]
stack: [ctx-rag]
---

# {{ $frontmatter.title }}

## 一句话结论

RAG（Retrieval-Augmented Generation）就是**先检索、再生成**：从知识库里找出相关的片段放进上下文，让模型基于这些片段回答并给出引用。==RAG 的质量瓶颈通常在检索，而不在生成==：要找的片段没被召回，模型再强也答不对。所以工程的重点是检索链路上的每一环：**切分、向量检索加关键词检索、融合（RRF）、重排（cross-encoder）、上下文组装**，每一环都能用 recall@k 和 MRR 量化。**Agentic RAG** 更进一步，把「什么时候搜、搜什么、搜几次」交给模型自己决定，代价是延迟和成本更高。

## 为什么用 RAG

想让模型回答它训练数据里没有的东西（公司内部文档、最新信息），有三条路：

| 方案 | 优点 | 缺点 |
|---|---|---|
| **RAG** | 知识随时更新；**能给出引用**；能按用户权限过滤；成本可控 | 检索没召回就答不对；要维护索引 |
| 微调 | 能学会格式、风格、领域语言 | **记事实不可靠**，更新知识要重新训练，没法引用来源，也没法做权限控制 |
| 长上下文全塞进去 | 实现最简单 | 贵、慢，有 lost in the middle 的问题，装不下大的知识库（见 [Token 与上下文窗口](/ai/tokens-context-window)） |

实践中，微调和 RAG 不冲突：微调管「怎么说」，RAG 管「说什么」。

## 整条链路

```
入库：解析（PDF / HTML / MD）→ 切分 → embedding → 写入（向量索引 + 全文索引）
查询：（改写）→ 向量检索 ∥ 关键词检索 → RRF 融合 → （rerank）→ 组装上下文 → 生成并引用 → 引用校验
```

DocPilot 的实现几乎一一对应：`ingest/`（解析、切分、管线）→ `embeddings.py` → `retrieval/search.py`（vector / fts / hybrid）→ `retrieval/fusion.py`（RRF）→ `retrieval/rerank.py`（Cohere）→ `agent/`（工具、循环、引用）。

## 1. 切分：最被低估的一环

### 为什么切分很重要

- **太大**：一个 chunk 里混了好几个主题，embedding 成了它们的平均，跟哪个问题都不够像；放进上下文也浪费 token。
- **太小**：一个事实的上下文被切掉了（「它」指的是谁？），单独检索出来没法理解。
- **切在不该切的地方**：一句关键的话被切成两半，分到两个 chunk 里，哪个都检索不到完整信息。

### DocPilot 的切分器（`ingest/chunk.py`）

三步：

1. **按 Markdown 标题切分**，让一个 chunk 尽量不跨章节；代码块里以 `#` 开头的行不算标题。
2. **超长的章节用重叠的窗口切开**，后面的窗口**重复章节标题**，让每个 chunk 都带着自己的上下文。
3. **把连续的小章节合并**，直到接近大小上限，避免出现几十个只有一个标题的小 chunk。

默认 500 token、重叠 60 token（`chunk_tokens`、`chunk_overlap_tokens`）。注释里给了一个关于重叠的保证：==重叠为 O 个词时，任何不超过 O+1 个词的片段，一定完整地落在某一个窗口里==。推导：窗口长度为 W，步长为 W − O。对一个从位置 p 开始、长度 L ≤ O + 1 的片段，取起点不超过 p 的最后一个窗口，它的起点 s 满足 s > p − (W − O)，所以它的终点 s + W − 1 > p + O − 1，也就是 ≥ p + O ≥ p + L − 1，片段完整地落在这个窗口里。所以只要短事实不超过 O+1 个词，就不会被切断。

（这个切分器按空格数词，中文会出问题，详见 [Token 与上下文窗口](/ai/tokens-context-window)。）

### 更进一步：给 chunk 加上下文

Anthropic 的 contextual retrieval：embedding 之前，先用一个小模型为每个 chunk 生成一两句「这段在整篇文档里讲什么」的说明，拼在 chunk 前面。DocPilot 在后续窗口里重复章节标题，是这个思路最便宜的版本。

## 2. 混合检索：向量 + 关键词

两路检索互补（见 [NoSQL 与全文检索](/backend/nosql-fulltext)、[Embedding 与向量索引](/ai/embedding-vector-index)）：

- **向量**：懂同义和改写（「休假」≈「请假」），不擅长精确匹配（错误码、端口号、人名）；
- **关键词（BM25 / FTS）**：精确匹配很强，不懂语义。

DocPilot 的混合模式里，两路各取 `candidate_k = 30` 个候选，用 `asyncio.gather` 在两个连接上**并发**执行，然后融合。

## 3. 融合：RRF

问题是：两路的分数**不在同一个量纲上**。`ts_rank_cd` 的值可能是 0.1 或 3.7，余弦相似度在 0–1 之间，直接相加没有意义；做归一化也很脆弱，分布一变就失效。

**RRF（Reciprocal Rank Fusion）只用排名，不用分数**：

$$\text{score}(d) = \sum_{\text{每个列表}} \frac{1}{k + \text{rank}_d}$$

```python
def rrf(rankings, k=60):
    scores = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking, start=1):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
```

- 两路都排在前面的文档得分最高；只在一路出现的，按它的排名得一部分分。
- **k = 60** 来自原论文（Cormack et al., 2009）。k 越大，排名靠前的优势越小，曲线越平：第 1 名得 1/61，第 10 名得 1/70，差距不大。这让融合结果更稳，不会被某一路的头部结果主导。
- 优点是**不需要调参、不需要分数校准**，所以是混合检索的默认做法。

## 4. 重排：cross-encoder

第一阶段的检索器（bi-encoder、BM25）是**分别**处理查询和文档的，速度快，但判断得比较粗。**cross-encoder** 把查询和文档**拼在一起**读，能看到两者之间逐词的交互，相关性判断准得多，但每个候选都要过一次模型，不能提前算好，太慢，没法对整个语料库做。

所以只对融合后的**头部候选**做重排。DocPilot 取 `max(top_k × 4, 20)` 个候选交给 Cohere Rerank，再取前 top_k 个。rerank 是一个可选的开关（`RERANKER=none|cohere`），这样它的收益能在 eval 里单独衡量：多花的延迟和费用值不值。

## 5. Agentic RAG：让模型决定怎么检索

传统 RAG 是固定的流水线：每个问题先检索 top 5，再生成。DocPilot 采用的是 **agentic RAG**：`search_docs` 是一个工具，模型自己决定要不要搜、搜什么、搜几次。

- **好处**：
  - **多跳问题**：「如果两个值班工程师都没响应，最终会找谁？他的职位是什么？」需要先搜值班手册，再搜团队名录。DocPilot 的 eval 里有 37 道这样的多文档问题。
  - **改写查询**：第一次没搜到，可以换个说法再搜。
  - **按需加深**：snippet 不够就 `read_doc` 读整篇。
  - 闲聊类问题可以不检索。
- **代价**：多一轮或几轮模型调用，延迟和成本更高；模型也可能偷懒不搜。所以 system prompt 要明确要求「回答任何关于文档的问题之前，先调用 search_docs」（见 [Prompt 设计与版本管理](/ai/prompt-versioning)），并用 `max_agent_steps` 限制步数（见 [Agent 循环](/stack/ag-loop)）。

## 6. 引用与校验

- 检索结果用 `<chunk id="…">` 包起来，模型在每个事实后面写 `[c:id]`。
- 生成结束后，把 id 回数据库解析，**查不到的 id 不产生引用**，界面上点引用就能看到原文。
- eval 用 judge 检查**引用忠实度**：带引用的论断，是否真的被所引用的原文支持。

## 7. 怎么评估

把检索和生成**分开**评估，否则分不清问题出在哪一环：

- **检索**：recall@5（标准答案的证据有多少出现在前 5 个结果里）、MRR（第一个相关结果排在第几位）。DocPilot 判断相关性的方法是：**chunk 里包含标准答案的原文片段（quote）就算相关**。好处是==换一种切分方式，标签依然有效==，不需要按 chunk id 重新标注。
- **生成**：正确率（judge 对照参考答案）、引用忠实度、拒答准确率（11 道文档里没有答案的题）、误拒率。
- **消融实验**：同一个命令就能跑 vector / fts / hybrid、带不带 rerank 的组合，用数字说明每一环的价值。DocPilot README 里的结果表还是 TBD：这套框架已经搭好，但真实的数字要等用真实的 embedding 模型跑过一次才有。面试时说清楚「指标怎么定义、怎么测」，比报一个没测过的数字更有说服力。

## 常见的失败模式

| 现象 | 可能原因 | 对策 |
|---|---|---|
| 明明有答案却说找不到 | 词汇不匹配；chunk 太大，embedding 被稀释 | 混合检索；查询改写；调小 chunk |
| 答案只对了一半 | 多跳问题只搜了一次；关键事实被切断 | agentic RAG 多次检索；切分时加重叠 |
| 引用了不相关的段落 | 重排不够；塞进了太多 chunk | 加 rerank；减少 top_k；把最相关的放在最前面或最后面 |
| 回答过时 | 文档更新了，索引没更新 | 更新时重新入库（DocPilot 删除文档时会级联删除它的 chunk）；记录文档版本 |
| 看到了不该看的文档 | 检索没有按权限过滤 | 在检索 SQL 里过滤（见[认证与鉴权](/backend/auth)） |
| 模型执行了文档里的指令 | 间接 prompt injection | 声明文档内容是数据；限制工具权限（见 [Prompt injection](/stack/sec-injection)） |

## 追问

::: details RAG、微调、长上下文分别适合什么场景？
RAG 适合知识经常更新、需要引用来源、需要按权限过滤的场景。微调适合学习格式、风格、领域语言，不适合记忆事实（不可靠、更新要重训、不能引用）。长上下文适合一次性处理一份不太长的材料，用来装整个知识库又贵又慢，还有 lost in the middle 的问题。常见的组合是微调管「怎么说」，RAG 管「说什么」。
:::

::: details chunk 的大小怎么选？重叠有什么用？
太大，embedding 被多个主题稀释，也浪费上下文；太小，丢失上下文（指代不明）。通常按 token 数定（比如 500），并且尽量按文档结构（标题、段落）切。重叠是为了避免关键句子被切断：DocPilot 的切分器保证，重叠 O 个词时，任何不超过 O+1 个词的片段都完整地落在某个窗口里。最终要用 recall@k 的消融实验来定。
:::

::: details 为什么混合检索用 RRF 融合，而不是把两路分数加起来？
两路分数的量纲不同（`ts_rank_cd` 的取值没有固定范围，余弦相似度在 0–1），直接相加没有意义，归一化又会随分布变化而失效。RRF 只用排名：每个文档的得分是它在各列表中 $1/(k+\text{rank})$ 之和，k 通常取 60（原论文的值），让曲线更平缓，不会被某一路的头部结果主导。它不需要调参，也不需要分数校准。
:::

::: details 为什么 rerank 只对头部候选做，而不是对整个语料库做？
cross-encoder 把查询和文档拼在一起读，判断更准，但每个候选都要过一次模型，而且依赖查询，没法提前算好。对整个语料库做太慢太贵。所以两阶段：第一阶段用便宜的检索器召回几十个候选，第二阶段只对头部做精排。DocPilot 对 `max(top_k × 4, 20)` 个候选调用 Cohere Rerank。
:::

::: details agentic RAG 和传统的 RAG 流水线有什么区别？各自的优缺点？
传统流水线每个问题固定先检索一次，再生成，简单、延迟可预测，但处理不了多跳问题，也不会换个说法重新搜。agentic RAG 把检索做成工具，模型决定要不要搜、搜什么、搜几次，能处理多跳问题和查询改写，还能按需读整篇文档；代价是更多的模型调用（延迟、成本），模型也可能偷懒不搜，所以要在 prompt 里强制要求并限制步数。
:::

::: details 怎么评估一个 RAG 系统？DocPilot 是怎么标注相关性的？
检索和生成分开评估。检索看 recall@k 和 MRR；生成看正确率、引用忠实度、拒答准确率和误拒率。DocPilot 的数据集为每道题标注了证据的**原文片段**，检索结果里的 chunk 包含这段原文就算相关，所以换切分方式标签也不会失效。数据集还包括单文档题、多文档题和无答案题，并支持按检索模式做消融实验。
:::

::: details 线上 RAG 回答「找不到」，但文档里明明有答案，你会怎么排查？
1. 先看 trace 里检索到了哪些 chunk：答案所在的 chunk 有没有被召回？
2. 没召回：分别看向量和关键词两路的排名，判断是词汇不匹配（试试查询改写或调整混合检索）、chunk 太大被稀释，还是答案被切断了；也要检查是不是被权限过滤、语言问题（比如中文没有走全文检索）挡掉了。
3. 召回了但没用上：看是否排得太靠后，被其他 chunk 淹没（加 rerank，减少 top_k），或者 prompt 的拒答条件太严格。
4. 修复后，把这个问题加进 eval 数据集，防止回归。
:::

## 参考

- Lewis et al., [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401)
- Cormack, Clarke & Büttcher, [Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [Anthropic: Introducing Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)
- Nogueira & Cho, [Passage Re-ranking with BERT](https://arxiv.org/abs/1901.04085)
- Gao et al., [Precise Zero-Shot Dense Retrieval without Relevance Labels (HyDE)](https://arxiv.org/abs/2212.10496)
- 实战代码：DocPilot `api/src/docpilot/ingest/chunk.py`、`retrieval/search.py`、`retrieval/fusion.py`、`retrieval/rerank.py`、`agent/tools.py`、`agent/citations.py`、`evals/metrics.py`、`evals/dataset.jsonl`
