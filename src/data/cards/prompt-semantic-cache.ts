import type { Card } from '@lib/flashcards'

const R = '/ai/prompt-semantic-cache'

export const cards: Card[] = [
  {
    id: 'pcache-three-layers',
    deck: 'ai',
    topic: '缓存分层',
    q: 'LLM 应用的 prompt caching、exact cache、语义缓存分别省什么？风险从低到高怎么排？',
    a: '1. **prompt caching**（provider / 推理引擎）：复用相同前缀的 KV cache，省 **prefill 时间和大部分输入费用**，**不改变输出**，几乎没有风险。\n2. **exact cache**（网关）：规范化后完全相同的请求直接返回旧响应，**整次调用都省掉**；风险是缓存了随机样本或失败的响应。\n3. **语义缓存**：问题意思相近就复用答案，命中率最高，但会**误命中**，返回另一个问题的答案。\n越往后省得越多、风险越大。',
    ref: `${R}#三层对比`,
  },
  {
    id: 'pcache-prefix-why',
    deck: 'ai',
    topic: 'prompt caching',
    q: 'provider 的 prompt caching 为什么要求前缀逐 token 完全一致？',
    a: 'prefill 时，每个 token 在每一层的 K、V 只依赖**它自己和它前面的 token**。两个请求前缀完全相同，这部分 KV 也完全相同，可以直接复用，只算新增的部分。\n前缀中间改了一个 token，从那个位置往后所有 token 的 KV 都不一样了，缓存全部失效。\n它只是计算上的复用，**不改变输出分布**，所以没有一致性问题。',
    ref: `${R}#原理`,
  },
  {
    id: 'pcache-layout-breakers',
    deck: 'ai',
    topic: 'prompt caching',
    q: '怎么排布 prompt 才能最大化 prompt cache 的命中？列出三种会悄悄破坏缓存的写法。',
    a: '**按变化频率从低到高排**：工具定义 → system prompt → 参考文档 / 示例 → 对话历史 → 本轮新消息，在稳定部分的末尾设置断点（Anthropic 用 `cache_control`）。\n**破坏缓存的写法**：\n1. system prompt 里带**精确的时间戳**；\n2. 工具列表顺序或 **JSON key 顺序不固定**；\n3. 把用户相关信息放在开头，或者滑动窗口每轮改动历史的开头。',
    ref: `${R}#什么会悄悄破坏缓存`,
  },
  {
    id: 'pcache-agent-savings',
    deck: 'ai',
    topic: 'prompt caching',
    q: '为什么 agent 场景从 prompt caching 中获益最大？DocPilot 在这方面有什么现成的优化点？',
    a: 'agent 每一步都要重发完整历史，而历史**只在末尾追加**，正好是「前缀不变、尾部增长」。把断点放在最新消息的末尾，下一步就能命中前面所有内容。缓存读取按 0.1 倍计价，一个三步回答粗算能把输入成本降低**三到四成**，步数越多省得越多。\nDocPilot 目前**没有设置 `cache_control`**，而它的 system prompt 和三个工具定义每一轮都完全一样，是最容易拿到的优化。',
    ref: `${R}#agent-场景的收益最大`,
  },
  {
    id: 'pcache-exact-key',
    deck: 'ai',
    topic: 'exact cache',
    q: 'LLMGateway 的 exact cache，key 里包含哪些东西、排除了哪些？排除的好处是什么？',
    a: '**包含**：路由后的 alias；规范化的消息（role、content 去首尾空白、name、tool_calls、tool_call_id）；所有影响答案的参数（tools、tool_choice、temperature、top_p、max_tokens、stop、response_format、seed、n、penalty、logprobs…）。JSON key 排序后再算 sha256。\n**排除**：`stream`、`stream_options`、`user`、`metadata`。\n好处：**流式和非流式请求共享同一个条目**，流式命中时把存下的响应切成 SSE 回放。\n默认只缓存 temperature 0、n = 1 的请求。',
    ref: `${R}#_2-exact-cache-完全相同的请求`,
  },
  {
    id: 'pcache-semantic-namespace',
    deck: 'ai',
    topic: '语义缓存',
    q: 'LLMGateway 的语义缓存为什么只 embed 最后一条用户消息，又要计算一个「命名空间」？',
    a: '同一句「帮我总结一下」，在不同的 system prompt 或历史下，答案完全不同。只比较最后一句的 embedding，就会把 A 场景的答案返回给 B 场景。\n所以：**只 embed 最后一条用户消息**用来比相似度；alias、**system prompt、之前所有轮次**、答案参数一起哈希成**命名空间**，只在同一个命名空间内查找。\n效果：上下文不同的请求，无论最后一句多像，**都不可能互相命中**。',
    ref: `${R}#llmgateway-的设计`,
  },
  {
    id: 'pcache-semantic-skip-tools',
    deck: 'ai',
    topic: '语义缓存',
    q: '为什么语义缓存要跳过带工具的请求，而 exact cache 却可以缓存它们？',
    a: '**语义缓存**：问题相似不代表需要同样的工具调用。「查一下我的订单状态」每次都该真的去查，重放上次的工具调用或答案会得到过时甚至错误的结果。LLMGateway 的原话：重放工具调用或过时的答案**比不命中更糟**。\n**exact cache**：工具定义和工具结果都在 key 里，命中意味着**输入字节级完全一致**，返回同样的输出是安全的（前提是 temperature 0）。',
    ref: `${R}#llmgateway-的设计`,
  },
  {
    id: 'pcache-semantic-threshold',
    deck: 'ai',
    topic: '语义缓存',
    q: '语义缓存的相似度阈值该怎么定？哪些场景下语义缓存很危险？',
    a: '**定阈值**：准备一批标注好「答案能否互换」的句子对，特别要放**难负例**（法国首都 vs 德国首都、按 key 排序 vs 按 value 排序），对每个阈值算 precision、recall、误命中率。LLMGateway 默认 **0.95**，每次命中都记日志以便审计。\n**危险场景**：答案个性化；时间敏感；只差一个数字或实体（2023 vs 2024 年营收）；**RAG 语料更新**后旧答案不会失效，要把语料版本放进命名空间。\n另外，每次没命中都要多付一次 embedding 调用，命中率低时不划算。',
    ref: `${R}#阈值要用标注数据来调`,
  },
]
