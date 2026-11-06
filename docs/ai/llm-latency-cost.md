---
title: 延迟与成本模型：TTFT、decode 与按 token 计价
status: draft
tags: [latency, ttft, cost, prefill, decode]
difficulty: 3
order: 3
related: [/ai/tokens-context-window, /ai/sampling-nondeterminism, /ai/llm-gateway, /ai/llm-tracing, /ai/model-tiering-batch]
stack: [llm-latency-cost]
---

# {{ $frontmatter.title }}

## 一句话结论

一次 LLM 调用的延迟分成两段：==**TTFT**（首 token 延迟）≈ 排队 + prefill，随输入长度增长，瓶颈是算力；**decode** 每吐一个 token 都要把整个模型权重从显存读一遍，瓶颈是显存带宽==。所以总延迟 ≈ TTFT + 输出 token 数 × 每 token 时间。成本也分两段：输入和输出分别计价，输出通常贵 4–5 倍，原因同样是 decode 的效率低。但在 agent 场景里，**输入 token 的总量远大于输出**，账单的大头往往是输入。所以 prompt caching 和压缩上下文，常常比换一个更便宜的模型省得更多。

## 为什么：prefill 和 decode 是两种完全不同的负载

### prefill：一次处理所有输入 token，吃算力

prompt 里的所有 token 可以**并行**算完，本质上是几个大矩阵乘。计算量约为：

$$\text{FLOPs} \approx 2 \times N_{params} \times n_{input}$$

举个例子：70B 模型、10K token 的输入，约 $2 \times 70\text{e}9 \times 10^4 = 1.4 \times 10^{15}$ FLOPs。H100 的 bf16 稠密算力约 989 TFLOPS，按 50% 的利用率算，单卡要 2.8 s；8 卡张量并行，大约 0.35 s。==TTFT 大致随输入长度线性增长==，超长上下文时 attention 的 $O(n^2)$ 项会再加上去。

### decode：一次只出一个 token，吃带宽

生成阶段每一步只算一个新 token，但要把**全部权重**从 HBM 读一遍（再加上这个序列的 KV cache）。算术强度很低，瓶颈在带宽：

$$\text{每 token 时间} \gtrsim \frac{\text{权重字节数}}{\text{显存带宽}}$$

70B 模型 bf16 是 140 GB 权重。H100 的带宽约 3.35 TB/s，单卡下限约 42 ms 一个 token，也就是约 24 token/s（实际上放不进一张卡，2 卡张量并行时带宽翻倍，约 48 token/s）。

**batching 是推理服务的经济基础**：读一遍权重可以同时给 batch 里的几十个请求各生成一个 token，单位成本大幅下降。这带来两个后端视角的推论：

1. **你的延迟取决于供应商的负载**：batch 越大，每个人的 decode 越慢，高峰期 TPOT 会变差。
2. **输出比输入贵**：同样一个 token，decode 占用 GPU 的时间远多于 prefill，所以定价上输出通常是输入的 4–5 倍。

推理侧的细节（KV cache、continuous batching、PD 分离）属于 AI infra 的范围，后端只需要记住这个模型。

## 延迟指标

| 指标 | 含义 | 主要取决于 |
|---|---|---|
| **TTFT** | 发出请求到收到第一个内容 token | 网络 + 排队 + prefill（输入长度、cache 命中） |
| **TPOT / ITL** | 两个输出 token 之间的平均间隔 | decode 带宽、供应商的 batch 大小 |
| **E2E latency** | 完整响应时间 | TTFT + 输出 token 数 × TPOT |
| **throughput** | 每秒生成多少 token（单流或整体） | 同上 |
| **goodput** | 满足 SLO（比如 TTFT < 1 s 且 TPOT < 50 ms）的请求比例或吞吐 | 综合 |

几个实践要点：

- **流式输出让 TTFT 成了用户感知的主要指标**。用户看到第一个字就觉得「有反应了」，所以优化 TTFT（缩短 prompt、命中 prompt cache）在体验上的收益最大。
- **推理模型多了一段 thinking**：thinking token 用户看不到，但它既占时间又按输出计费。对用户来说，TTFT 变成了「thinking 时长 + 第一个可见 token」。DocPilot 给回答用 `effort: medium`，给 judge 用 `effort: low`，就是在用推理深度换延迟和成本。
- **看分位数，不看平均值**：LLM 延迟的长尾很重，p99 可能是 p50 的好几倍（供应商排队、长输出、偶发重试）。

### 实战：怎么测才不自欺

LLMGateway 的压测设计有几处值得抄：

- **TTFT 在客户端测，定义为收到第一个内容 delta 的时间**，而不是收到响应头的时间。有的服务会先返回 200 和响应头，再慢慢开始生成。
- **把网关自身的开销单独算**：`x-gateway-overhead-ms` = 总耗时减去等待模型的时间（包括失败的尝试和语义缓存的 embedding 调用），这样才能证明「网关加的延迟可以忽略」。
- **Windows 上压测要用 `127.0.0.1`，不要用 `localhost`**：`localhost` 会先尝试 IPv6，每个新连接可能卡约 2 s，在报告里表现成一个**假的 p99**。这类问题提醒我们：长尾延迟要先排除测量工具本身的问题。
- **prefix caching 实验要串行跑**：比较「共享的长 system prompt」和「每个请求前缀都不同」两种情况的 TTFT 时，并发请求会引入排队，干扰结果。

## 成本模型

### 基本公式

$$\text{cost} = \frac{n_{in} \times P_{in} + n_{out} \times P_{out}}{10^6}$$

价格单位是每百万 token 的美元数。DocPilot 的 `pricing.py` 就是按这个公式给每一轮算出 `cost_usd` 写进 trace 的。它价格表里填的 Opus 是输入 \$4、输出 \$20 每百万 token（以官方价格页为准）。价格表里没有的模型按 \$0 记，并打一条告警日志，避免因为缺少价格让请求失败。代价是这部分成本被静默低估，所以要盯着那条告警。

### agent 场景：输入才是大头

算一个 DocPilot 典型的三步回答（用上面的价格）：

| 步骤 | 输入 token | 输出 token |
|---|---|---|
| 1. 决定搜索 | 3.0K（system + 工具定义 + 问题） | 100（tool call） |
| 2. 看了 5 个 chunk 再搜一次 | 5.6K | 100 |
| 3. 写答案 | 8.2K | 400 |
| **合计** | **16.8K** | **600** |

成本 = 16.8K × \$4/M + 600 × \$20/M = \$0.067 + \$0.012 ≈ **\$0.08**。

输出单价是输入的 5 倍，可总成本里 85% 来自输入。原因是每一步都要重发全部历史（见 [Token 与上下文窗口](/ai/tokens-context-window)）。所以优化顺序是：

1. **prompt caching**：system prompt、工具定义、前几步的历史是固定前缀，命中缓存后按折扣价计费。Anthropic 的缓存读取价是基础输入价的 0.1 倍，写入缓存价是 1.25 倍（5 分钟 TTL）。见 [Prompt caching 与语义缓存](/stack/gw-cache)。
2. **控制工具返回的大小**：限制 top_k、截断长文档（DocPilot 的 `read_doc` 最多返回 40 个 chunk）。
3. **压缩旧的工具结果**：见[上下文压缩](/stack/ctx-compaction)。
4. **模型分级**：简单问题用小模型，见[模型分级与 batch](/stack/ai-cost)。
5. **Batch API**：不需要实时返回的任务（离线 eval、批量打标）走 batch 接口，主流供应商都给 50% 的折扣，代价是最长 24 小时内返回。

### 成本要随请求记录下来

只看月账单定位不了问题，要做到**每一次调用**都能查到 token 数和成本：

- DocPilot 每一轮在 `traces` 表里写一行：模型、输入 / 输出 token、延迟、成本、检索到的 chunk、工具调用。
- LLMGateway 按 API key 记账，在响应头里返回 `x-gateway-cost-usd`。流式请求在 cache miss 时不返回这个头，因为成本要等最后一个 chunk 带回 usage 才知道。

## 估算速查

| 问题 | 估法 |
|---|---|
| 一个回答要多久 | TTFT（短 prompt 约 0.3–1 s，长 prompt 更久）+ 输出 token 数 ÷ 每秒 token 数 |
| 1000 token 的回答，50 token/s | 光 decode 就要 20 s，所以必须流式输出 |
| 每天 1 万次对话的成本 | 单次成本 × 1 万；agent 场景要先把每一步的输入累加起来再算 |
| prompt cache 能省多少 | 可缓存前缀的占比 × 命中率 × 90%（按 0.1 倍读取价算） |

## 追问

::: details 为什么 LLM API 的输出 token 比输入 token 贵？
prefill 一次并行处理所有输入 token，是算力受限的矩阵乘，GPU 利用率高；decode 每生成一个 token 都要把全部权重从显存读一遍，是带宽受限的，GPU 大部分算力在空转，只能靠 batching 摊薄。同样一个 token，输出占用的 GPU 时间远多于输入，所以定价通常高 4–5 倍。
:::

::: details TTFT 和 TPOT 分别由什么决定？要优化 TTFT 有哪些手段？
TTFT = 网络 + 排队 + prefill，主要随输入长度增长；TPOT 由 decode 的带宽和供应商的 batch 大小决定。

优化 TTFT 的手段：
1. 缩短 prompt：精简 system prompt，少塞检索结果；
2. 命中 prompt cache：固定的前缀放在最前面；
3. 选离用户近的 region；
4. 用更小的模型；
5. 推理模型调低 effort，减少 thinking 时间。
:::

::: details 估算：70B 模型 bf16，单个请求在 H100 上 decode 能有多快？
decode 每一步都要读一遍全部权重：70B × 2 字节 = 140 GB。H100 带宽约 3.35 TB/s，所以每个 token 至少 42 ms，约 24 token/s。实际上一张 80 GB 的卡放不下，要 2 卡张量并行，带宽合计翻倍，约 48 token/s 的上限。供应商靠 batching 让同一次权重读取服务很多请求，所以单个用户感受到的速度还取决于当时的负载。
:::

::: details 一个 agent 应用的 LLM 成本突然翻倍，你会怎么查？
1. 按 trace 拆分：是请求数变多了，还是每次的 token 变多了？
2. token 变多的话，看是输入还是输出：输入涨通常是步数变多、工具返回变大或历史没截断；输出涨可能是 prompt 改了、模型话变多了，或者 thinking 的 effort 被调高了。
3. 看 prompt cache 命中率：system prompt 或工具定义的顺序一改，前缀就对不上了，命中率会归零。
4. 看模型分布：路由规则是不是把更多流量导到了贵的模型上。
5. 看价格表：新模型没有价格时会按 0 记（DocPilot 的做法），成本是之前被低估了，而不是现在翻倍。
:::

::: details 为什么 LLM 应用几乎都要做流式输出？
decode 慢：一个 1000 token 的回答在 50 token/s 下要 20 s。非流式的话，用户要盯着空白屏幕等完整的 E2E 延迟；流式的话，用户感知的延迟变成 TTFT（约 1 s），后面的内容边生成边读。代价是后端要处理长连接、代理缓冲、中途出错这些问题，见[流式接口](/stack/api-streaming)。
:::

::: details 压测 LLM 服务时，有哪些容易让数字失真的坑？
1. TTFT 要按第一个**内容** token 算，不能按响应头算。
2. 测量工具自己的问题，比如 Windows 上 `localhost` 先试 IPv6，每个新连接卡约 2 s，变成假的 p99（LLMGateway 的教训）。
3. 缓存污染：重复的 prompt 会命中 prompt cache 或网关缓存，要么用真实的 trace，要么每轮清空缓存，并且记录命中率。
4. 并发引入排队：测单请求的效果（比如 prefix caching）要串行跑。
5. 只看平均值：一定要看 p50 / p95 / p99。
:::

## 参考

- [Anthropic: Prompt caching（价格倍率）](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)、[Anthropic: Message Batches](https://docs.anthropic.com/en/docs/build-with-claude/batch-processing)
- [OpenAI: Batch API](https://platform.openai.com/docs/guides/batch)
- [NVIDIA H100 规格（带宽、算力）](https://www.nvidia.com/en-us/data-center/h100/)
- Kipply, [Transformer Inference Arithmetic](https://kipp.ly/transformer-inference-arithmetic/)（prefill / decode 的算力与带宽估算）
- Zhong et al., [DistServe: Disaggregating Prefill and Decoding for Goodput-optimized LLM Serving](https://arxiv.org/abs/2401.09670)（goodput 的定义）
- 实战代码：DocPilot `api/src/docpilot/pricing.py`、`schema.sql`（`traces` 表）、`config.py`（`anthropic_effort`）；LLMGateway README「Load test」「Overhead definition」两节
