---
title: 上下文压缩：裁剪、摘要、外置与子 agent
status: draft
tags: [context, compaction, summarization, agent, long-running]
difficulty: 3
order: 11
related: [/ai/tokens-context-window, /ai/conversation-memory, /ai/prompt-semantic-cache, /ai/rag, /ai/tool-calling-mcp]
stack: [ctx-compaction]
---

# {{ $frontmatter.title }}

## 一句话结论

上下文压缩是在 **token 预算**和**信息保真**之间做取舍。当上下文快满了，或者质量开始下降时，有几种手段：

- **裁剪**：丢掉或截断，最便宜，但不可逆；
- **摘要**：用 LLM 把旧内容压缩成一段话，有损，还要多花一次调用；
- **外置**：大块内容存到外部，上下文里只留引用，需要时再取回来；
- **结构化笔记**：agent 自己维护一份进度文件；
- **子 agent**：把探索性的工作交给一个独立的上下文去做，只带回结论。

==原则：优先丢弃能重新获取的内容（工具结果、文件原文），绝不丢弃无法恢复的信息（用户的要求、已经做出的决定、关键标识符）==。

## 为什么窗口变大了还要压缩

1. **成本**：agent 每一步都重发全部历史，输入 token 随步数近似平方增长（见 [Token 与上下文窗口](/ai/tokens-context-window)）。
2. **延迟**：prefill 时间随输入长度增长，TTFT 跟着变长。
3. **质量**：上下文越长，模型越容易被无关内容分散注意力（context rot），中间位置的信息也更容易被忽略（lost in the middle）。
4. **硬上限**：长时间运行的 agent（跑几小时的编码任务、几百步的调研），迟早会超过任何窗口。

所以，「窗口装得下」和「应该全放进去」是两回事。

## 五种手段

### 1. 在源头控制大小

最便宜的压缩是一开始就别放进来太多。DocPilot 在工具层就做了限制：

- `search_docs` 的 `top_k` 最多 10；
- `read_doc` 最多返回 40 个 chunk（`READ_DOC_MAX_CHUNKS`）；
- 参数解析失败的错误信息只带原始参数的前 200 个字符；
- 给界面的 `output` 只放 200 字的摘要，完整内容只给模型。

### 2. 清理旧的工具结果

工具结果通常是上下文里最大的部分，也是**最容易重新获取的**：搜索可以再搜，文件可以再读。所以压缩时首先把**较早的**工具结果替换成一个占位符（「此处结果已清理，需要的话请重新调用工具」），保留工具调用本身（让模型知道自己做过什么）。Anthropic 的 API 也提供了自动清理旧工具结果的 context editing 能力。

### 3. 摘要（compaction）

上下文接近上限时，让模型把到目前为止的对话压缩成一份摘要，然后用「system prompt + 摘要 + 最近几轮」开启一个新的上下文继续工作。Claude Code 的 `/compact` 和自动压缩就是这样做的。

摘要里**必须保留**：

- 用户的原始目标和明确提出的约束；
- 已经做出的决定，以及做决定的原因；
- 精确的标识符：文件路径、id、URL、版本号（必须**逐字**保留，摘要很容易把它们改错）；
- 还没解决的问题和下一步计划。

可以丢弃的：工具的原始输出、已经被否定的尝试、重复的讨论。

摘要的风险：

- **有损**：丢掉的细节，后面可能恰好用得上；
- **可能出错**：摘要本身是一次 LLM 生成，可能编造或者曲解；
- **有成本**：额外一次调用，输入就是整个待压缩的上下文。

### 4. 外置：上下文里只放引用

把大块内容存在上下文之外（数据库、文件、对象存储），上下文里只保留一个**轻量的引用**（id、路径、URL），需要时再通过工具取回，即 just-in-time retrieval。

DocPilot 的设计本身就是这个思路：检索结果带着 chunk id，模型引用的是 `[c:42]` 而不是整段原文；需要更多内容时，用 `read_doc(document_id)` 按 id 去取。数据库就是 agent 的外部存储。跨轮次也是：`messages` 表只存最终答案，检索结果留在 `traces` 表里，不进下一轮上下文（见[会话与记忆](/ai/conversation-memory)）。

==和「先把所有可能相关的内容都塞进来」相比，按需取用让上下文始终只装着当前需要的东西==，代价是多几次工具调用。

### 5. 结构化笔记和子 agent

- **结构化笔记**：长任务里，让 agent 维护一份进度文件（目标、已完成、下一步、遇到的坑），每次压缩或重启后先读这份文件。它比对话摘要更可靠，因为它是 agent 有意识地写下来的，而且结构固定。顺带一提，这个知识库本身就是一个长时间运行的 agent 循环写出来的：进度和约定都记在仓库根目录的 `plan.md` 里，每一轮先读它、写完再勾掉。
- **子 agent**：把「读 20 个文件找到相关代码」这种探索性的工作交给一个子 agent，它在**自己独立的上下文**里完成探索，只把几百 token 的结论交回给主 agent。主 agent 的上下文不会被几万 token 的中间结果撑满。代价是多一个 agent 的成本，并且信息在交接时会丢失细节。

## 压缩和 prompt caching 的冲突

prompt caching 要求前缀不变（见 [Prompt caching 与语义缓存](/ai/prompt-semantic-cache)），而压缩会改写历史。实践中：

- **固定的前缀不动**：system prompt 和工具定义永远放在最前面，压缩只改它们后面的部分；
- **压缩要少做、一次做多**：每一轮都改历史开头，缓存就永远命中不了；攒到接近阈值再一次性压缩，之后又能连续命中很多轮；
- **清理工具结果也是在改前缀**：清理的位置越靠前，失效的缓存越多。所以要成批清理，不要每一轮都清理一点。

## DocPilot 目前的情况

一轮回答最多 6 步（`max_agent_steps`），单次 `read_doc` 最多约 20K token，最坏情况下一轮的上下文也在可控范围内，所以 DocPilot 在**轮内**没有做压缩；在**轮间**，只保留最终答案，本身就是一种压缩。如果以后扩展到长任务（比如「读完整个知识库写一份报告」），就需要加上：旧工具结果的清理、接近阈值时的摘要，以及一个让 agent 记录进度的笔记工具。

## 怎么验证压缩没有伤害效果

- 构造**需要用到早期信息**的长任务 eval：比如第 3 轮用户提的约束，在第 30 步时是否还被遵守。
- 对比压缩前后的任务成功率、token 成本和延迟。
- 抽查摘要：关键的 id 和路径有没有被改错，决定有没有被遗漏。

## 追问

::: details 上下文窗口已经有几十万甚至上百万 token 了，为什么还要压缩？
1. 成本：agent 每一步重发全部历史，输入 token 随步数近似平方增长；
2. 延迟：prefill 随长度增长，TTFT 变长；
3. 质量：上下文越长，越容易被无关内容干扰，中间的信息容易被忽略；
4. 长任务迟早会超过任何窗口。

「装得下」不等于「应该全放进去」。
:::

::: details 上下文要压缩时，应该优先丢弃什么、保留什么？
优先丢弃能重新获取的内容：旧的工具结果（可以再搜、再读）、已经被否定的尝试、重复的讨论。必须保留无法恢复的信息：用户的目标和约束、已经做出的决定及原因、精确的标识符（路径、id、版本号，要逐字保留）、未解决的问题和下一步计划。
:::

::: details 用 LLM 做摘要式压缩有什么风险？怎么缓解？
有损（丢掉的细节后面可能用到）、可能出错（摘要本身可能编造或改错 id）、有成本（一次以全部上下文为输入的调用）。缓解：规定摘要必须包含的字段（目标、约束、决定、标识符、下一步）；标识符要求逐字复制；配合结构化笔记，而不是只依赖摘要；用长任务 eval 检查早期约束在压缩后是否还被遵守。
:::

::: details 什么是 just-in-time retrieval？和预先把相关内容都放进上下文相比有什么好处？
上下文里只保留轻量的引用（id、路径），需要内容时再通过工具按引用取回。好处是上下文始终只装着当前需要的东西，便宜，干扰也少；代价是多几次工具调用。DocPilot 的检索结果带 chunk id，模型用 `[c:id]` 引用，需要更多内容时用 `read_doc` 按 id 去取，就是这种模式。
:::

::: details 子 agent 为什么能帮助管理上下文？代价是什么？
探索性的工作（读很多文件、做很多次搜索）在子 agent 自己独立的上下文里完成，只把一段浓缩的结论交回给主 agent，主 agent 的上下文不会被大量中间结果撑满。代价：多一个 agent 的 token 成本；交接时细节会丢失，主 agent 只能看到子 agent 选择报告的内容；子 agent 犯的错，主 agent 不容易发现。
:::

::: details 上下文压缩和 prompt caching 有什么冲突？怎么兼顾？
prompt caching 要求前缀不变，压缩和清理工具结果都会改写历史，导致缓存失效。兼顾的办法：system prompt 和工具定义永远固定在最前面；压缩攒到接近阈值再一次性做，而不是每一轮都改；工具结果也成批清理。这样压缩之后又能连续命中很多轮。
:::

## 参考

- [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic: Context editing](https://docs.anthropic.com/en/docs/build-with-claude/context-editing)
- Chroma Research, [Context Rot: How Increasing Input Tokens Impacts LLM Performance](https://research.trychroma.com/context-rot)
- Liu et al., [Lost in the Middle](https://arxiv.org/abs/2307.03172)
- 实战代码：DocPilot `api/src/docpilot/agent/tools.py`（`READ_DOC_MAX_CHUNKS`、`top_k` 上限）、`agent/loop.py`（`max_steps`）、`store.py`（只存最终答案）
