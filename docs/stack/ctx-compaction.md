---
title: 上下文压缩
---

# 上下文压缩

窗口再大也要压缩：agent 的输入 token 随步数近似平方增长，长上下文更慢、更容易分心，长任务迟早会超过任何窗口。手段从便宜到昂贵：在源头限制工具输出的大小、清理旧的工具结果、外置（上下文里只留 id，按需取回）、摘要压缩（LLM 把旧对话浓缩成一段，有损且可能出错）、结构化笔记和子 agent（独立的上下文，只交回结论）。原则是优先丢弃能重新获取的内容，绝不丢弃用户的约束、已做的决定和精确的标识符。

- **DocPilot 在源头限制大小**：`top_k ≤ 10`，`read_doc` 最多 40 个 chunk；模型引用 `[c:id]`，需要时用 `read_doc` 按 id 取回。
- **压缩和 prompt caching 冲突**：固定前缀不动，压缩攒到阈值再一次性做。
- **摘要必须逐字保留标识符**，并且要用「早期约束在后期还被遵守吗」这样的长任务 eval 来验证。

笔记：[上下文压缩](/ai/context-compaction)

**延伸阅读**：[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)、[Context Rot](https://research.trychroma.com/context-rot)
