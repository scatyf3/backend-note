---
title: Prompt caching 与语义缓存
status: draft
tags: [prompt-caching, semantic-cache, exact-cache, cost]
difficulty: 3
order: 8
related: [/backend/caching, /ai/llm-latency-cost, /ai/sampling-nondeterminism, /ai/embedding-vector-index, /ai/conversation-memory, /ai/llm-gateway]
stack: [gw-cache]
---

# {{ $frontmatter.title }}

## 一句话结论

LLM 应用有三种缓存，分别在三个层次上省钱：

1. **provider 的 prompt caching**：复用相同前缀已经算好的 KV cache，省掉 prefill 的时间和大部分输入费用，**不改变输出**。
2. **网关的 exact cache**：完全相同的请求直接返回存下来的响应，**整次调用都省掉**。
3. **语义缓存**：问题「意思差不多」就复用之前的答案，命中率最高，但**有误命中的风险**。

==越往后，省得越多，风险也越大==。prompt caching 几乎没有副作用，应该默认用上；exact cache 要处理好「什么样的请求算相同」；语义缓存则必须用严格的阈值、隔离的命名空间和可审计的命中日志来约束。

## 1. Prompt caching：复用前缀的计算

### 原理

prefill 阶段，模型为输入的每个 token 在每一层算出 K、V 向量（见[延迟与成本模型](/ai/llm-latency-cost)）。如果两个请求的**前缀完全相同**，这部分 KV 也完全相同，可以直接复用，只需要计算新增的部分。所以：

- 必须是**前缀**，并且**逐 token 完全一致**。中间改了一个字，后面的就全部失效。
- 它是计算上的优化，**不改变输出的分布**，所以没有一致性问题。
- 省的是 TTFT 和输入费用。Anthropic 的缓存读取按基础输入价的 0.1 倍计费，写入缓存按 1.25 倍计费（5 分钟 TTL，每次命中会刷新；也可以选 1 小时 TTL，写入价更高）。OpenAI 对超过 1024 token 的 prompt 自动做前缀缓存并给折扣。自托管的 vLLM（automatic prefix caching）和 SGLang（RadixAttention）也有同样的机制。

### 怎么排布 prompt 才能命中

把内容按**变化频率从低到高**排列：

```
工具定义（几乎不变）
system prompt（很少变）
参考文档 / few-shot 示例（按任务变）
对话历史（每轮追加）
本轮新消息（每次都变）
```

Anthropic 需要显式地用 `cache_control` 标出缓存断点（最多 4 个），并且有最小可缓存长度的要求；OpenAI 是自动的，但同样只匹配前缀。

### 什么会悄悄破坏缓存

- **system prompt 里有时间戳**：「当前时间是 2026-11-06 01:34:12」，每个请求都不一样。要放的话，放到消息末尾，或者只精确到天。
- **工具定义的顺序或序列化不稳定**：工具列表从 dict 或 set 生成、JSON 的 key 顺序不固定，每次的字节都不同。
- **把用户相关的信息放得太靠前**：比如在 system prompt 开头插入用户名，就没法在用户之间共享缓存。
- **改写历史的开头**：滑动窗口每轮丢掉最早的一条消息，整个前缀就都变了（见[会话与记忆](/ai/conversation-memory)）。

### agent 场景的收益最大

agent 每一步都要重发完整的历史，而历史只在末尾追加，正好是「前缀不变、尾部增长」。在每一步把断点放在最新消息的末尾，下一步就能命中前面所有内容。

拿 [延迟与成本模型](/ai/llm-latency-cost) 里的三步回答估一下：累计 16.8K 输入 token 中，第 2、3 步的大约 8.6K 是在重复前面的前缀。假设这部分都命中缓存（按 0.1 倍计价），每一步新增的内容按 1.25 倍写入缓存，粗算下来这一轮的输入成本从 16.8K 的等价量降到约 10–11K，也就是降低三到四成。==对话越长、步数越多，省得越多。==

DocPilot 目前**没有设置 `cache_control`**。它的 system prompt 和三个工具定义每一轮都完全一样，是最容易拿到的优化：在工具定义和 system prompt 之后加一个断点，再在历史的末尾加一个滚动的断点。

LLMGateway 的压测里专门设计了一个 prefix caching 实验（`loadtest/prefix_cache_experiment.py`，跑在 vLLM 上）：对比「共享同一个长 system prompt」和「每个请求前缀都不同」两种情况的 TTFT，并且**串行执行**，排除排队的干扰。

## 2. Exact cache：完全相同的请求

网关层面，完全相同的请求直接返回之前的响应，延迟从几秒降到几毫秒，费用降到零。难点是定义「完全相同」。LLMGateway 的 `gateway/cache/exact.py`：

- **key 包含**：alias（路由后的模型别名）、消息（只取 role、content、name、tool_calls、tool_call_id，字符串内容去掉首尾空白），以及所有**会影响答案的参数**：tools、tool_choice、temperature、top_p、max_tokens、stop、response_format、seed、n、各种 penalty、logprobs 等。
- **key 排除**：`stream`、`stream_options`、`user`、`metadata`。它们不影响答案，排除之后，流式和非流式请求可以**共享同一个缓存条目**，流式请求命中时把存下的响应重新切成 SSE 回放。
- **JSON 序列化时 key 排序**，再算 sha256，保证同样的内容一定得到同样的 key。
- **只缓存确定性的请求**：默认只缓存 temperature 为 0 且 n = 1 的请求（见[采样与非确定性](/ai/sampling-nondeterminism)），客户端可以用 `x-gateway-cache: allow` / `skip` 显式覆盖。
- **带工具的请求也缓存**：工具定义和工具结果都在 key 里，命中意味着输入完全一致。
- **只缓存成功的响应**，写入放在响应发出之后，TTL 为 3600 秒（见[缓存](/backend/caching)）。

## 3. 语义缓存：意思差不多就复用

用户问「怎么重置密码」和「忘记密码了怎么办」，exact cache 匹配不上，但答案是一样的。语义缓存把问题转成 embedding，找到足够相似的旧问题，就返回它的答案。

### LLMGateway 的设计

`gateway/cache/semantic.py` 文件开头写着「为了可解释性而不是规模」，几个关键决定：

1. **只 embed 最后一条用户消息**。
2. **其余所有会影响答案的东西都进命名空间**：alias、system prompt、之前的所有轮次、答案参数，一起算一个哈希。只在同一个命名空间里查找，所以 ==system prompt 或历史不同的两个请求，无论最后一句多像，都不可能互相命中==。
3. **有工具的请求不做语义缓存**：问题相同不代表需要的工具调用相同，重放一个工具调用或一个过时的答案，比不命中更糟。
4. **严格的阈值**：默认 0.95。
5. **每次命中都打一条结构化日志**：相似度、阈值、两边 prompt 的哈希，便于事后审计误命中、调整阈值。
6. **暴力搜索**：每个命名空间保留最近 2000 条，numpy 一次矩阵乘，不到 1 毫秒（见 [Embedding 与向量索引](/ai/embedding-vector-index)）。
7. **成本要算清楚**：每次没命中也要多付一次 embedding 调用，耗时单独记在 `x-gateway-semantic-ms` 响应头里。==只有命中率 × 每次命中省下的延迟，大于每个请求多出的 embedding 开销，语义缓存才划算。==

### 阈值要用标注数据来调

`scripts/tune_semantic_threshold.py` 会对每个候选阈值计算 precision、recall 和误命中率。项目自带的 40 对样本是手写的，故意放了很多**难负例**：「法国的首都是哪」vs「德国的首都是哪」，「按 key 排序」vs「按 value 排序」。这些句子的 embedding 相似度很高，答案却完全不同。README 还特别说明：离线的 mock embedder 是词汇级而不是语义级的，用它跑阈值调优，正好能看出为什么必须用真实的模型和标注数据。

### 语义缓存什么时候危险

- **个性化的答案**：答案依赖用户身份或账户状态，要么不缓存，要么把用户信息放进命名空间。
- **时间敏感的问题**：「今天的天气」「最新版本」。
- **只差一个数字或一个实体**：「2023 年营收」vs「2024 年营收」，向量几乎一样。
- **RAG 应用的语料更新**：答案依赖文档库的内容。如果在 DocPilot 前面加语义缓存，用户上传新文档之后，缓存里的旧答案并不会失效。要把语料的版本号放进命名空间，或者在文档变更时清空缓存。

## 三层对比

| | prompt caching | exact cache | 语义缓存 |
|---|---|---|---|
| 位置 | 供应商 / 推理引擎 | 网关 / 应用 | 网关 / 应用 |
| 省什么 | prefill 的时间和大部分输入费用 | 整次调用 | 整次调用 |
| 命中条件 | 前缀逐 token 一致 | 规范化后的请求完全一致 | 同一命名空间内 embedding 相似度 ≥ 阈值 |
| 会改变输出吗 | 不会 | 会冻结一次输出（所以只缓存确定性请求） | 会返回另一个问题的答案 |
| 主要风险 | 几乎没有，只是可能没命中 | 缓存了随机样本或失败的响应 | 误命中 |

## 追问

::: details provider 的 prompt caching 是怎么工作的？为什么要求前缀完全一致？
prefill 时每个 token 的 K、V 只依赖它自己和它前面的 token。两个请求的前缀完全相同，这部分 KV 也完全相同，可以直接复用，只计算新增的部分。前缀中间改了一个 token，从那个位置往后的 KV 都不同了，所以必须逐 token 一致。它只是计算上的复用，不改变输出分布。
:::

::: details 怎么组织 prompt 才能最大化 prompt cache 的命中率？哪些写法会破坏缓存？
按变化频率从低到高排列：工具定义 → system prompt → 参考文档 / 示例 → 历史 → 新消息，在稳定部分的末尾设置断点。

破坏缓存的写法：system prompt 里带精确的时间戳；工具列表顺序或 JSON key 顺序不固定；把用户相关信息放在开头；滑动窗口每轮改动历史的开头。
:::

::: details 网关的 exact cache，key 应该包含哪些字段、排除哪些字段？
包含所有会影响答案的东西：路由后的模型、规范化的消息（role、content 去首尾空白、tool_calls、tool_call_id、name）、tools、tool_choice、采样参数、max_tokens、stop、response_format、seed、n 等。排除不影响答案的字段：stream、stream_options、user、metadata，这样流式和非流式请求可以共享缓存。JSON key 排序后再算哈希。默认只缓存 temperature 0、n = 1 的请求。
:::

::: details 语义缓存为什么要有「命名空间」？LLMGateway 的命名空间里有什么？
同样一句「给我总结一下」，在不同的 system prompt 或对话历史下，答案完全不同。只比较最后一句话的 embedding，就会把 A 场景的答案返回给 B 场景。LLMGateway 只 embed 最后一条用户消息，把 alias、system prompt、之前的所有轮次和答案参数一起哈希成命名空间，只在同一个命名空间内查找。这样上下文不同的请求，无论最后一句多像，都不可能互相命中。
:::

::: details 为什么语义缓存要跳过带工具的请求？
问题相似不代表需要同样的工具调用。比如「查一下我的订单状态」，每次都应该真的去查，返回上一次的工具调用或上一次的答案会给出过时甚至错误的结果。LLMGateway 的注释原话是：重放一个工具调用或过时的答案，比不命中更糟。exact cache 可以缓存带工具的请求，因为工具结果也在 key 里，命中意味着输入完全一致。
:::

::: details 语义缓存的阈值怎么定？什么时候语义缓存不划算？
用标注数据定：准备一批句子对，标出「答案能否互换」，特别要放进难负例（法国首都 vs 德国首都、2023 年营收 vs 2024 年营收），对每个阈值算 precision、recall 和误命中率，在误命中率可接受的前提下选召回最高的阈值。LLMGateway 默认 0.95，并记录每次命中以便审计。

不划算的情况：每次没命中都要多付一次 embedding 调用；命中率低、或者答案个性化、时间敏感、依赖经常更新的语料时，多付的成本和误命中的风险超过了收益。
:::

::: details 一个 agent 应用想降低 LLM 成本，三种缓存的优先级怎么排？
1. 先上 **prompt caching**：几乎没有风险，agent 的历史只在末尾追加，命中率天然很高，固定的 system prompt 和工具定义更是每次都能命中；
2. 再看 **exact cache**：适合确定性的、重复的请求，比如离线批处理、eval 重跑、固定模板的调用；
3. 最后才考虑 **语义缓存**：只用在答案不依赖用户、不依赖时间、语料稳定的 FAQ 类场景，并且要有严格的阈值、命名空间和审计。
:::

## 参考

- [Anthropic: Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)、[OpenAI: Prompt caching](https://platform.openai.com/docs/guides/prompt-caching)
- [vLLM: Automatic Prefix Caching](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching.html)
- Zheng et al., [SGLang: Efficient Execution of Structured Language Model Programs](https://arxiv.org/abs/2312.07104)（RadixAttention）
- [GPTCache](https://github.com/zilliztech/GPTCache)（开源语义缓存）
- 实战代码：LLMGateway `gateway/cache/exact.py`、`gateway/cache/semantic.py`、`scripts/tune_semantic_threshold.py`、`loadtest/prefix_cache_experiment.py`、`config/gateway.yaml`；DocPilot `llm/anthropic_provider.py`（未设置 `cache_control`）
