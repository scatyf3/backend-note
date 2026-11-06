---
title: 采样、非确定性与幻觉
status: draft
tags: [sampling, temperature, determinism, hallucination]
difficulty: 3
order: 2
related: [/ai/tokens-context-window, /ai/llm-latency-cost, /ai/prompt-semantic-cache, /ai/offline-evals]
stack: [llm-sampling]
---

# {{ $frontmatter.title }}

## 一句话结论

LLM 每一步输出的是**下一个 token 的概率分布**，再从里面**采样**出一个 token，所以同一个 prompt 两次结果不同是设计使然。temperature 设成 0 也只是「尽量确定」：推理服务的 batch 组成会改变浮点运算的顺序，结果可能还是会变。幻觉是同一机制的副作用：模型生成的是「看起来合理」的 token，并不知道真假。==对后端来说，这意味着 LLM 调用不是纯函数==：不能用字符串相等写测试，重试拿到的是另一个答案，缓存会把某一次随机样本冻结下来。所以需要 eval、结构化输出和 grounding 来兜底。

## 为什么：生成就是一步一步采样

每生成一个 token，模型对整个词表输出一组 logits $z_i$，经过带温度的 softmax 变成概率：

$$p_i = \frac{\exp(z_i / T)}{\sum_j \exp(z_j / T)}$$

然后按这个分布抽一个 token，拼到输入后面，再算下一步。各个参数的作用：

| 参数 | 作用 | 直觉 |
|---|---|---|
| **temperature** $T$ | $T<1$ 让分布更尖，$T>1$ 让分布更平；$T \to 0$ 退化为每步取最大值（greedy） | 控制「冒险程度」 |
| **top-k** | 只在概率最高的 k 个 token 里抽 | 砍掉长尾 |
| **top-p（nucleus）** | 只在累计概率达到 p 的最小集合里抽 | 长尾按分布形状自适应地截断 |
| **min-p** | 只保留概率不低于「最高概率 × p」的 token | 比 top-p 更稳的自适应截断 |
| **seed** | 固定随机数种子 | 部分供应商支持，承诺的是 best-effort |

为什么不一直用 greedy：greedy 容易陷入重复、乏味的循环（Holtzman et al. 2019 把这叫做 neural text degeneration），而且每一步都选最可能的 token，整体也不一定是最好的序列。创作、头脑风暴适合中等温度；抽取、分类、写代码适合低温度。

另一点要注意的是：**很多新模型已经不让调这些参数了**。LLMGateway 在 README 里记录了一个兼容性取舍：发给 `claude-*-5*` 模型的请求会直接丢掉 `temperature` / `top_p`，因为这些模型带着这两个参数会返回 400。DocPilot 调 Claude 时也没传 temperature，而是用 `output_config.effort` 控制推理深度。==「把 temperature 设成 0 来保证稳定」这个习惯，在推理模型上越来越不成立了。==

## temperature = 0 为什么还是不确定

直觉上 greedy 是确定的，但生产环境里同一个请求发两次，结果仍然可能不同。原因按重要性排：

1. **batch 不变性缺失**：推理服务把很多用户的请求拼成一个 batch 一起算。batch 的大小和组成会影响 kernel 怎么切分归约（比如矩阵乘、attention、RMSNorm 里的求和）。浮点加法不满足结合律，$(a+b)+c \ne a+(b+c)$，所以同一个请求在不同负载下算出的 logits 有微小差异。两个候选 token 的概率很接近时，差异就会翻转 argmax，之后整个序列都会分岔。Thinking Machines 2025 年的文章把这一点讲得最清楚：主要原因是 batch 不变性缺失，而不是一般认为的「GPU 并发导致的随机性」。
2. **MoE 路由**：专家容量有上限时，同一 batch 里的其他请求会影响你的 token 被分到哪个专家。
3. **供应商侧的变化**：模型的小版本更新、量化方式、硬件型号不同。OpenAI 用 `system_fingerprint` 字段暴露后端配置，fingerprint 变了，同一个 seed 的结果就不保证一样。

工程上的结论：==不要依赖「同输入同输出」==。需要可复现的话（比如 eval），要记录每次实际的输出，而不是指望重跑一遍能得到同样的结果。

## 对后端的影响

### 1. 缓存会冻结一次随机样本

LLMGateway 的 exact cache 默认**只缓存 temperature 为 0 的请求**（`gateway/cache/exact.py` 的 `is_cacheable`），`n > 1` 的请求也不缓存。原因是：缓存一个 temperature=0.8 的回答，等于把一次随机抽样永久地返回给所有后来的人，调用方本来想要的是多样性。客户端可以用 `x-gateway-cache: allow` 显式开启，或者用 `skip` 显式关闭。见 [Prompt caching 与语义缓存](/stack/gw-cache)。

### 2. 重试不是「同一个结果再来一次」

传统 API 的重试假设下游幂等：重发请求能拿到相同的结果。LLM 的重试拿到的是**另一个样本**。如果第一次的结果已经流式输出了一半，换个后端重试会把两次不同的生成拼在一起。LLMGateway 的规则是**流式请求只在首字节之前 fallback**，后面的失败只发 SSE `error` 事件，不再重试，见 [LLM 网关](/stack/gw-routing)。

### 3. 测试要从断言字符串改成断言性质

不能写 `assert answer == "48 primary shards"`，要换成：

- **结构化输出 + schema 校验**：输出必须是合法 JSON，字段齐全（见 [Provider API 与结构化输出](/stack/gw-api)）。
- **确定性的检查**：DocPilot 的 eval 里有一项「cited-evidence rate」，直接检查被引用的 chunk 里是否包含标准答案的原文 quote，不需要 LLM 参与。
- **LLM-as-judge**：对开放式的回答用另一个模型打分，并人工抽查 judge 的判断（见[离线 eval](/stack/ev-offline)）。
- **单元测试用假模型**：DocPilot 有一个 `LLM_PROVIDER=fake` 的脚本化 provider，单元测试和离线开发不需要 key，结果完全确定。

### 4. 想要稳定，就利用随机性本身

- **self-consistency**：同一个问题采样多次，取多数答案。用成本换准确率，适合答案可比较的场景（数字、分类）。
- **logprobs 当置信度**：部分 API 返回每个 token 的对数概率，可以据此判断「模型自己有多确定」，低于阈值就转人工或拒答。

## 幻觉：为什么会有，怎么压

### 来源

模型的训练目标是「预测下一个 token」，它学到的是语言的统计规律，而不是一个可以查询的事实数据库。几种典型来源：

- **知识缺失还硬答**：训练数据里没有，或者超出了知识截止日期，模型仍然会生成流畅但错误的内容。
- **评估在鼓励猜**：OpenAI 2025 年的论文 *Why Language Models Hallucinate* 指出，多数 benchmark 只算准确率，答错和说「不知道」都得 0 分，于是模型被训练得更倾向于猜一个答案，而不是承认不确定。
- **上下文冲突或噪音**：检索进来的文档互相矛盾，或者无关内容太多。
- **长生成里的误差累积**：前面采样到一个错误 token，后面会为了自洽继续编下去。

### 后端能做的事

幻觉不能被消灭，只能被**约束、检测和暴露**。DocPilot 的设计是一个完整的例子：

1. **grounding**：system prompt 要求「只用工具返回的文档回答」「找不到就逐字回复固定的拒答句」，见 `agent/prompts.py`。
2. **可验证的引用**：每个事实后面要带 `[c:<chunk_id>]`。生成结束后，`agent/citations.py` 把这些 id **回数据库查一遍**：==幻觉出来的 id 查不到，就不会产生引用==，在界面上显示为没有出处的文字，而不是指向一个错误的来源。
3. **拒答可度量**：eval 数据集里有 11 道文档中没有答案的题，专门测「该拒答时有没有拒答」（refusal accuracy）和「不该拒答时有没有乱拒答」（false refusals）。
4. **引用忠实度**：judge 拿到每个被引用 chunk 的原文，检查带引用的论断是否真的被这段原文支持（citation faithfulness）。

==把「模型说的话」和「数据库里的事实」用 id 连起来，是让幻觉可检测的关键。==

## 追问

::: details temperature、top-k、top-p 分别控制什么？什么场景用什么值？
- **temperature** 缩放 logits：越低分布越尖，$T \to 0$ 就是 greedy。
- **top-k** 只在概率最高的 k 个里抽。
- **top-p** 在累计概率达到 p 的最小集合里抽，会随分布形状自适应。

抽取、分类、代码、结构化输出用低温度（0–0.3）；对话用中等温度；创意写作用更高的温度。注意：部分新的推理模型已经不接受这些参数，改用 effort / thinking 之类的参数来控制。
:::

::: details 为什么 temperature = 0 时同一个请求还会返回不同的结果？
主要原因是推理服务缺少 **batch 不变性**：你的请求和别人的请求拼在一个 batch 里，batch 的大小会影响 kernel 的归约顺序，而浮点加法不满足结合律，logits 会有微小差异。两个候选 token 很接近时 argmax 被翻转，后面的序列就分岔了。其他原因还有 MoE 的专家容量、供应商的版本和硬件变化。结论：不要依赖同输入同输出，需要复现就把实际输出记下来。
:::

::: details 网关缓存 LLM 响应时，为什么默认只缓存 temperature = 0 的请求？
temperature > 0 的调用方要的是**随机样本**。缓存一次结果，等于把这一次抽样永久地返回给所有人，破坏了调用方要的多样性。temperature = 0 的请求期望的就是确定的结果，缓存不改变语义。LLMGateway 还会排除 `n > 1` 的请求，并允许客户端用 `x-gateway-cache: allow` / `skip` 显式覆盖默认行为。
:::

::: details LLM 的输出不确定，单元测试该怎么写？
分层写：

1. **单元测试**用脚本化的假模型（DocPilot 的 `fake` provider），测的是 agent 循环、工具调度和流式编码这些确定性的代码。
2. **集成测试**断言性质：JSON schema 合法、必填字段齐全、引用 id 都存在。
3. **质量评估**用固定数据集跑 eval，指标包括确定性检查（引用里是否含标准答案原文）和 LLM-as-judge，结果看分布和趋势，不看单次。
:::

::: details 怎么在产品里降低幻觉的影响？
幻觉不能根除，要做的是约束、检测和暴露：

- **约束**：只基于检索到的文档回答，找不到就用固定句式拒答；用结构化输出限制格式。
- **检测**：要求逐句引用，并把引用 id 回库校验，查不到的 id 不产生引用；用 judge 检查引用是否真的支持论断。
- **暴露**：界面上把来源展示出来让用户核对；低置信度的回答（logprobs 低、self-consistency 投票不一致）转人工处理。
- **度量**：eval 里加上无答案的题，单独看拒答准确率。
:::

::: details 同一个问题采样 5 次取多数（self-consistency），代价和适用场景是什么？
代价是 5 倍的输出 token 和成本；并行采样的话，延迟约等于最慢的那一次。适合答案可以归一比较的任务，比如数学题、分类、抽取一个数字，投票能显著提高准确率。开放式长文本没法直接投票，需要再用一个模型做聚合，收益也小得多。
:::

## 参考

- Holtzman et al., [The Curious Case of Neural Text Degeneration](https://arxiv.org/abs/1904.09751)（nucleus sampling）
- Horace He / Thinking Machines Lab, [Defeating Nondeterminism in LLM Inference](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/)
- Kalai et al. (OpenAI), [Why Language Models Hallucinate](https://arxiv.org/abs/2509.04664)
- Wang et al., [Self-Consistency Improves Chain of Thought Reasoning](https://arxiv.org/abs/2203.11171)
- [OpenAI: Reproducible outputs（seed 与 system_fingerprint）](https://platform.openai.com/docs/advanced-usage/reproducible-outputs)
- 实战代码：LLMGateway `gateway/cache/exact.py`（`is_cacheable`）与 README「Anthropic translation」一节；DocPilot `agent/prompts.py`、`agent/citations.py`、`evals/judge.py`、`llm/fake_provider.py`
