import type { Card } from '@lib/flashcards'

const R = '/ai/context-compaction'

export const cards: Card[] = [
  {
    id: 'compact-why',
    deck: 'ai',
    topic: '上下文压缩',
    q: '上下文窗口已经有几十万甚至上百万 token 了，为什么 agent 还需要压缩上下文？',
    a: '1. **成本**：每一步都重发全部历史，输入 token 随步数**近似平方增长**；\n2. **延迟**：prefill 随长度增长，TTFT 变长；\n3. **质量**：越长越容易被无关内容干扰（context rot），中间的信息容易被忽略（lost in the middle）；\n4. **硬上限**：跑几小时的长任务迟早会超过任何窗口。\n「装得下」不等于「应该全放进去」。',
    ref: `${R}#为什么窗口变大了还要压缩`,
  },
  {
    id: 'compact-what-to-drop',
    deck: 'ai',
    topic: '上下文压缩',
    q: '压缩上下文时，应该优先丢弃什么？必须保留什么？',
    a: '**优先丢弃能重新获取的**：旧的工具结果（可以再搜、再读）、已经被否定的尝试、重复的讨论。清理工具结果时保留工具调用本身，让模型知道自己做过什么。\n**必须保留无法恢复的**：\n1. 用户的目标和明确的约束；\n2. 已经做出的决定和原因；\n3. 精确的**标识符**（路径、id、URL、版本号），要**逐字**保留；\n4. 未解决的问题和下一步计划。',
    ref: `${R}#_3-摘要-compaction`,
  },
  {
    id: 'compact-summary-risks',
    deck: 'ai',
    topic: '摘要',
    q: '用 LLM 做摘要式压缩有哪些风险？怎么缓解？',
    a: '**风险**：1. **有损**，丢掉的细节后面可能用到；2. **可能出错**，摘要本身是一次生成，可能编造或改错 id；3. **有成本**，要以全部待压缩内容为输入调用一次模型。\n**缓解**：规定摘要必须包含的字段（目标、约束、决定、标识符、下一步）；标识符要求**逐字复制**；配合**结构化笔记**（agent 有意写下的进度文件比对话摘要更可靠）；用长任务 eval 检查早期约束在压缩后是否还被遵守。',
    ref: `${R}#_3-摘要-compaction`,
  },
  {
    id: 'compact-jit',
    deck: 'ai',
    topic: '外置',
    q: '什么是 just-in-time retrieval（上下文里只放引用）？DocPilot 是怎么体现的？',
    a: '大块内容存在上下文之外，上下文里只留**轻量的引用**（id、路径），需要时再通过工具按引用取回。好处是上下文只装着当前需要的东西，更便宜、干扰更少；代价是多几次工具调用。\nDocPilot：检索结果带 chunk id，模型用 `[c:42]` 引用而不是复述原文；需要更多内容就用 `read_doc(document_id)` 按 id 去取。跨轮次也是：`messages` 只存最终答案，检索结果留在 `traces` 表里。',
    ref: `${R}#_4-外置-上下文里只放引用`,
  },
  {
    id: 'compact-source-limit',
    deck: 'ai',
    topic: '上下文压缩',
    q: '最便宜的上下文压缩是什么？DocPilot 在工具层做了哪些限制？',
    a: '最便宜的是**在源头就别放进来太多**。DocPilot 的做法：\n1. `search_docs` 的 `top_k` 最多 **10**；\n2. `read_doc` 最多返回 **40** 个 chunk（`READ_DOC_MAX_CHUNKS`）；\n3. 参数不是合法 JSON 时，错误信息只带原始参数的**前 200 个字符**；\n4. 给界面的 `output` 只放 200 字摘要，完整内容只给模型。\n再加上 `max_agent_steps = 6`，一轮的上下文上限是可控的，所以轮内不需要额外压缩。',
    ref: `${R}#_1-在源头控制大小`,
  },
  {
    id: 'compact-subagent',
    deck: 'ai',
    topic: '子 agent',
    q: '子 agent 为什么能帮助管理上下文？代价是什么？',
    a: '探索性的工作（读几十个文件、做很多次搜索）在子 agent **自己独立的上下文**里完成，只把几百 token 的**浓缩结论**交回主 agent，主 agent 的上下文不会被几万 token 的中间结果撑满。\n**代价**：多一个 agent 的 token 成本；交接时**细节丢失**，主 agent 只能看到子 agent 选择报告的内容；子 agent 犯的错，主 agent 不容易发现。',
    ref: `${R}#_5-结构化笔记和子-agent`,
  },
  {
    id: 'compact-vs-caching',
    deck: 'ai',
    topic: '上下文压缩',
    q: '上下文压缩和 prompt caching 有什么冲突？怎么兼顾？',
    a: 'prompt caching 要求**前缀不变**，压缩和清理工具结果都会改写历史，导致缓存失效。\n兼顾的办法：\n1. system prompt 和工具定义**永远固定在最前面**，压缩只改它们后面的部分；\n2. 压缩**攒到接近阈值再一次性做**，而不是每一轮都改，之后又能连续命中很多轮；\n3. 工具结果也**成批清理**，清理的位置越靠前，失效的缓存越多。',
    ref: `${R}#压缩和-prompt-caching-的冲突`,
  },
]
