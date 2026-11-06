---
title: 自托管推理还是调 API：算账、运维与混合部署
status: draft
tags: [self-hosting, vllm, gpu, cost, inference, hybrid]
difficulty: 4
order: 23
related: [/ai/model-tiering-batch, /ai/llm-gateway, /ai/llm-latency-cost, /ai/tokens-context-window, /ai/prompt-semantic-cache, /backend/cost, /backend/service-boundaries]
stack: [ai-selfhost]
---

# {{ $frontmatter.title }}

## 一句话结论

调 API 还是自托管，是在两种模式之间取舍：

- **调 API**：按 token 付费、零运维、能用最强的模型；
- **自托管**：按 GPU 小时付费、完全可控、数据不出自己的环境。

==自托管只有在这些条件下才划算==：流量大而且稳定（GPU 利用率高）；任务窄，开源的小模型就够用；长前缀重复多（prefix caching 收益大）；数据或合规要求不能交给第三方；需要微调或者对延迟有严格控制。否则，算上运维的人力，API 几乎总是更便宜。实践中最常见的答案是**混合**：网关后面同时挂着 API 和自托管的模型，按规则路由，自托管的那一路挂了就自动 fallback 到 API。

## 为什么不是简单的「自己跑更便宜」

API 的价格里包含了供应商的利润，所以直觉上自己跑会更便宜。但供应商有两个个人和中小团队很难具备的优势：

1. **利用率**：供应商把成千上万个客户的请求混在一起，GPU 几乎一直满载；你自己的 GPU 在夜里和周末大部分时间是空闲的，**空闲的 GPU 照样按小时收费**。
2. **规模和工程**：推理引擎的调优、量化、批处理、硬件选型，都有专门的团队在做。

所以比较的关键是：**你能让 GPU 达到多高的利用率**。

## 算账：每百万 token 的成本

自托管的成本可以这样估算：

$$\text{每百万 token 的成本} = \frac{\text{GPU 每小时的价格}}{\text{每秒处理的 token 数} \times \text{利用率} \times 3600} \times 10^6$$

举一个**假设的**例子（数字只为说明方法）：一张 GPU 每小时 2 美元，跑一个小模型，开了批处理之后整体每秒能处理 2000 个 token，平均利用率 50%：

$$\frac{2}{2000 \times 0.5 \times 3600} \times 10^6 \approx 0.56 \text{ 美元 / 百万 token}$$

对比 LLMGateway 价格表里小模型 API 的价格（输入 0.10–0.40 美元 / 百万 token），这个自托管方案反而更贵。要让自托管划算，需要更高的利用率、更大的吞吐，或者对比的是更贵的大模型 API。而这还**没有算人力**。

### 被低估的成本

- **运维人力**：驱动和 CUDA 的版本、推理引擎的升级、监控、值班；
- **为峰值预留的容量**：GPU 的扩容很慢，加载一个模型就要几分钟，所以必须提前为峰值准备好容量，平时就是闲置的；
- **质量差距**：开源的小模型在复杂任务上通常不如最强的商业模型，可能需要更多的工程（更好的 prompt、微调、更多的检索）来弥补；
- **工程投入**：批处理参数、量化、上下文长度、工具调用的格式，都要自己调。

### 公平地比较：给自托管的模型标上价格

LLMGateway 的价格表里，自托管的 Qwen 模型价格是 0，旁边有一行注释：「**自托管的模型，如果希望计入成本，就把它设成摊销后的 GPU 成本**。」这个细节很重要：价格设成 0，成本仪表盘上自托管的那一路看起来就是免费的，按成本路由的决策也会被扭曲。==自托管不是免费的，只是付费的方式不同==（见[成本](/backend/cost)）。

## 什么时候自托管划算

| 条件 | 原因 |
|---|---|
| 流量大且稳定 | GPU 利用率高，单位成本才能降下来 |
| 任务窄，小模型够用 | 分类、抽取、改写，小模型显存小、吞吐大 |
| 长前缀大量重复 | 自托管引擎的 prefix caching 让重复的长 prompt 几乎免费 |
| 数据不能出域 | 合规要求、客户合同、敏感数据 |
| 需要微调 | 在自己的数据上微调过的模型（见[模型分级与 batch](/stack/ai-cost)） |
| 延迟要求严格、不想被限流 | 不受供应商的排队和速率限制影响 |

注意：「数据不能出域」这一条，很多时候也可以通过供应商的区域部署、企业协议、零数据留存等方式满足，不一定非要自托管。

## 自托管的技术栈

主流的推理引擎是 **vLLM**、**SGLang**、**TGI**。它们提供的核心能力：

- **continuous batching**：新请求随时插进正在进行的 batch，GPU 一直满载；
- **PagedAttention**：按页管理 KV cache，减少显存碎片，能容纳更多并发的序列；
- **prefix caching**：相同前缀的 KV cache 自动复用；
- **量化**：int8、int4（AWQ、GPTQ），权重显存降到原来的二分之一甚至四分之一；
- **张量并行**：一个模型放不进一张卡时，切到多张卡上；
- **OpenAI 兼容的接口**：可以直接挂到网关后面。

### 显存怎么算

- **权重**：参数量 × 每个参数的字节数。1.5B 参数的模型，bf16 约 3 GB；70B 约 140 GB，需要两张 80 GB 的卡。
- **KV cache**：剩下的显存决定了能同时容纳多少个序列、多长的上下文（KV cache 的计算见 [Token 与上下文窗口](/ai/tokens-context-window)）。
- 推理引擎里，这两个由几个参数控制。

### 实战：LLMGateway 在大学集群上跑 vLLM

`deploy/vllm-slurm.sh` 在 Slurm 集群上申请一张 GPU（作业最长 4 小时），启动：

```bash
vllm serve Qwen/Qwen2.5-1.5B-Instruct \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.85 \
  --enable-auto-tool-choice --tool-call-parser hermes \
  --enable-prefix-caching
```

- `--max-model-len 8192`：每个序列的最大上下文，限制了单个序列能占用的 KV cache；
- `--gpu-memory-utilization 0.85`：权重加 KV cache 最多使用 85% 的显存；
- `--enable-auto-tool-choice --tool-call-parser hermes`：开源模型的工具调用需要指定输出格式的解析器；
- `--enable-prefix-caching`：脚本里可以通过环境变量换成 `--no-enable-prefix-caching`，作为实验的对照组。

然后从笔记本电脑通过 SSH 隧道把端口转发出来，在网关的配置里打开 `VLLM_ENABLED`。几个值得注意的地方：

- **工具调用要额外配置**：开源模型的工具调用依赖特定的输出格式和解析器（这里是 hermes），可靠性通常不如商业 API 原生的工具调用，要用 eval 验证。
- **这是实验环境，不是生产环境**：单张 GPU、作业 4 小时后自动结束、通过 SSH 隧道访问，没有任何高可用。

### 网关里的混合部署

网关的配置把自托管和 API 组合在一起：

```yaml
cheap:
  - {backend: vllm, model: Qwen/Qwen2.5-1.5B-Instruct}
  - {backend: anthropic, model: claude-haiku-5-5}
  - {backend: mock-primary, model: mock-small}
local:
  - {backend: vllm, model: Qwen/Qwen2.5-1.5B-Instruct}
  - {backend: mock-primary, model: mock-small}
rules:
  - name: long-prompts-to-local    # 长 prompt 在 vLLM 上能吃到 prefix caching 的收益
    min_prompt_tokens: 3000
    aliases: [fast, cheap]
    route_to: local
```

- **自托管排在链的最前面，API 作为 fallback**：集群上的作业结束或者 GPU 出了问题，请求自动 fallback 到 API，应用完全感知不到（见 [LLM 网关](/ai/llm-gateway)）。
- **把最适合自托管的流量路由过去**：长 prompt 的 prefill 是最贵的部分，而自托管引擎的 prefix caching 能让重复的长前缀几乎免费。所以「超过 3000 token 的请求走本地」这条规则，正好把自托管最有优势的那部分流量导过去。
- vLLM 默认不启用（`VLLM_ENABLED=false`），没有 GPU 时整个系统照样能跑。

### 怎么验证 prefix caching 的收益

LLMGateway 的 `loadtest/prefix_cache_experiment.py` 设计了一个干净的对照实验：

- **共享组**：所有请求使用同一个很长的 system prompt，只有问题不同；
- **独占组**：在 system prompt 的**开头**插入一个随机字符串，让每个请求的前缀都不一样，无法复用；
- 两组的 TTFT 之差，就是 prefix caching 的收益；
- **请求串行发送**，排除排队对 TTFT 的影响；
- 通过网关测试时，带上 `x-gateway-cache: skip`，绕过网关自己的缓存，只测 vLLM 的效果；
- 还可以用关闭了 prefix caching 的服务器再跑一遍，确认这时「共享组」和「独占组」的结果一样。

（注意随机字符串要放在**开头**：放在末尾的话，前面的长 prompt 仍然是共享的前缀，照样能命中缓存。）

## 决策清单

1. **先用 API 做出产品**，用 eval 确定需要的质量水平；
2. 用 trace 统计真实的流量：量多大、多稳定、哪些任务占了大头、前缀重复率多高；
3. 估算自托管的单位成本，**用真实的利用率**，并算上人力；
4. 挑出最适合自托管的流量（量大、任务窄、前缀重复多），在网关上单独路由过去，API 作为 fallback；
5. 给自托管的模型标上摊销后的价格，用同一套 eval 和成本指标持续比较。

## 追问

::: details 什么情况下自托管推理比调用 API 更划算？
流量大且稳定（GPU 利用率高）；任务窄，开源小模型够用；长前缀大量重复，prefix caching 收益大；数据或合规不允许交给第三方；需要微调；延迟要求严格、不想受供应商限流。否则算上空闲时间和运维人力，API 通常更便宜。数据不出域的要求，有时也可以通过供应商的区域部署或企业协议满足。
:::

::: details 怎么估算自托管模型每百万 token 的成本？
GPU 每小时价格 ÷（每秒处理的 token 数 × 利用率 × 3600）× 10⁶。关键是利用率：供应商把大量客户的请求混在一起，GPU 几乎一直满载；自己的 GPU 夜里和周末大多空闲，但照样按小时计费。比如 2 美元每小时、每秒 2000 token、利用率 50%，约 0.56 美元每百万 token，可能比小模型的 API 还贵，而且还没算人力。
:::

::: details 自托管有哪些容易被低估的成本？
运维人力（驱动、CUDA、引擎升级、监控、值班）；为峰值预留的空闲容量（GPU 扩容慢，加载模型要几分钟）；开源模型和最强商业模型之间的质量差距，需要额外的工程来弥补；批处理、量化、上下文长度、工具调用格式这些都要自己调。
:::

::: details LLMGateway 的价格表里，自托管模型的价格为什么不应该一直是 0？
价格设成 0，成本仪表盘上自托管的那一路看起来就是免费的，和 API 的成本对比、按成本路由的决策都会被扭曲。配置里的注释也写明了：要计入成本，就设成摊销后的 GPU 成本。自托管不是免费的，只是付费的方式从按 token 变成了按 GPU 小时。
:::

::: details vLLM 这类推理引擎提供了哪些关键能力？启动时要调哪些参数？
continuous batching（GPU 持续满载）、PagedAttention（按页管理 KV cache，容纳更多并发序列）、prefix caching、量化、张量并行、OpenAI 兼容接口。常调的参数：`--max-model-len`（每个序列的最大上下文，影响 KV cache）、`--gpu-memory-utilization`（权重加 KV cache 能用多少显存）、是否开启 prefix caching，以及开源模型工具调用的解析器（比如 hermes）。
:::

::: details 怎么把自托管模型和 API 组合起来用？
在网关上做混合部署：自托管的模型放在 fallback 链的最前面，API 作为备用，自托管那一路挂了请求就自动转到 API。再用规则把最适合自托管的流量导过去，比如 LLMGateway 把超过 3000 token 的 `fast` / `cheap` 请求路由到本地的 vLLM，利用 prefix caching 让重复的长前缀几乎免费。自托管默认关闭，没有 GPU 时系统照样能跑。
:::

::: details 怎么设计一个实验来验证 prefix caching 的收益？
两组对照：共享组所有请求使用同一个长 system prompt；独占组在 system prompt 的开头插入随机字符串，让前缀无法复用（随机串必须放在开头，放在末尾的话前面仍是共享的前缀）。两组 TTFT 之差就是收益。请求要串行发送，排除排队的影响；经过网关时绕过网关自己的缓存；可以再用关闭了 prefix caching 的服务器跑一遍作为验证。LLMGateway 的 `prefix_cache_experiment.py` 就是这样设计的。
:::

## 参考

- Kwon et al., [Efficient Memory Management for Large Language Model Serving with PagedAttention (vLLM)](https://arxiv.org/abs/2309.06180)
- [vLLM 文档](https://docs.vllm.ai/)（引擎参数、prefix caching、tool calling）
- Zheng et al., [SGLang](https://arxiv.org/abs/2312.07104)
- Kipply, [Transformer Inference Arithmetic](https://kipp.ly/transformer-inference-arithmetic/)
- 实战代码：LLMGateway `deploy/vllm-slurm.sh`、`loadtest/prefix_cache_experiment.py`、`config/gateway.yaml`（aliases、rules、prices）与 README「vLLM on a university cluster」一节
