---
title: 成本：度量、归因与优化
status: draft
tags: [cost, finops, unit-economics, cloud, llm-cost]
difficulty: 3
order: 26
related: [/ai/llm-latency-cost, /ai/model-tiering-batch, /ai/prompt-semantic-cache, /ai/llm-tracing, /backend/observability, /backend/containers-cicd, /ai/self-host-vs-api]
stack: [arch-cost]
---

# {{ $frontmatter.title }}

## 一句话结论

后端的成本由几块组成：**计算 + 存储 + 网络 + 托管服务 + 人力**。在 AI 应用里，**LLM 的 token 费用往往是最大的单项**，而且随用量线性增长；agent 每一步都要重发历史，成本甚至会随步数超线性增长。成本工程分三步：

1. **度量**：把成本归因到每个请求、每个功能、每个用户、每个租户，算出**单位经济学**（每次对话的成本 vs 收入）；
2. **优化**：先找最大的那一项；
3. **治理**：预算、告警、配额。

==没有归因的成本是没法优化的==：月底的总账单只能告诉你花多了，不能告诉你花在哪了。

## 为什么成本也是架构问题

传统 SaaS 的边际成本很低：多服务一个用户，几乎不增加多少服务器开销，毛利可以很高。AI 应用不一样：**每一次对话都要实打实地付推理费用**，用户越活跃，花得越多。如果一个用户每个月付 20 美元，却平均产生 30 美元的 token 费用，用户越多亏得越多。所以成本必须在设计时就考虑，而不能等账单来了再说。

## 成本的组成

| 类别 | 主要项 | 常见的坑 |
|---|---|---|
| 计算 | 实例、容器、函数、GPU | 空闲的资源；按峰值配置却很少达到峰值 |
| 存储 | 数据库、对象存储、备份、向量索引 | 冷数据放在热存储里；备份和快照无限保留 |
| 网络 | 出站流量、跨可用区 / 跨区域流量 | **出站和跨区域流量**常常是意外的大头 |
| 托管服务 | 托管数据库、队列、搜索、观测平台 | 日志量和高基数的指标让观测费用失控 |
| LLM / API | token 费用、embedding、rerank | agent 的多步调用、长上下文、没有缓存 |
| 人力 | 开发、运维、值班 | 自建一个本可以买的服务 |

几个省钱的基本手段：

- **计算的购买方式**：稳定的基线负载用预留实例或节省计划，可以中断的批处理任务用竞价实例，波动的部分用按需实例；
- **缩容到零**：DocPilot 在 Fly 上设置 `min_machines_running = 0`，没有流量时不花钱，代价是冷启动（见[容器、K8s 与 CI/CD](/backend/containers-cicd)）；
- **就近部署**：应用和数据库放在同一个区域，比如 DocPilot 部署在 `iad`，托管的 Postgres 也要选在同一区域，否则每次查询都要付跨区域的延迟和流量费；
- **控制观测的成本**：日志采样和设置保留期；指标保持低基数。LLMGateway 关掉了 Prometheus 客户端默认的 `_created` 序列，因为它们会让抓取量翻倍却没什么用（见[可观测性](/backend/observability)）。

## LLM 成本：度量和归因

### 每一次调用都要记成本

- **DocPilot**：每一轮回答在 `traces` 表里存一个 `cost_usd`，由 `pricing.py` 按「输入 token × 输入价 + 输出 token × 输出价」算出（见 [LLM tracing](/ai/llm-tracing)）。
- **LLMGateway**：按 API key 统计 token 和花费（Prometheus 的 `gateway_cost_usd_total`），每个 key 每月的累计花费存在 Redis 里（用于预算），响应头里带着这次请求的成本；另外还有一个指标 `gateway_cost_saved_usd_total`，记录**缓存命中省下了多少钱**，这样缓存的价值就能用钱来衡量。

### 价格表也是要维护的代码

- 价格会变，新模型会上线。LLMGateway 的配置里写着「请对照供应商的价格页核实」；DocPilot 的价格表里没有的模型，会按 0 记账并打一条告警日志，避免请求因为缺少价格而失败，代价是成本会被**悄悄低估**，所以要盯住那条告警。
- 演示用的 mock 后端也配置了价格，配置里明确标注那是「假装的数字」，目的是让演示的仪表盘上能看到非零的花费。
- 缓存读取、batch 接口、thinking token 的计价方式都和普通的输入输出不同，计算时要区分（LLMGateway 目前把缓存读取也按全价算，是轻微的高估）。

### 单位经济学

把成本按业务维度汇总：

- **每次对话的平均成本**、**每个活跃用户每月的成本**，和用户付的钱放在一起看；
- 按**功能**拆分：哪个功能最贵？是不是有个很少人用的功能占了大部分花费？
- 按**模型**和 **prompt 版本**拆分：上一次 prompt 改动之后成本涨了没有？

## LLM 成本：优化

按 [延迟与成本模型](/ai/llm-latency-cost) 里的分析，agent 场景下**输入 token 才是大头**（一个三步回答约 85% 的成本来自输入）。优化的顺序：

1. **prompt caching**：固定的 system prompt 和工具定义、只在末尾追加的历史，缓存读取只按约十分之一的价格计费，一个三步回答粗算能省三到四成（见 [Prompt caching 与语义缓存](/ai/prompt-semantic-cache)）；
2. **控制上下文的大小**：限制检索的 top_k 和单次工具返回的大小，压缩旧的工具结果（见[上下文压缩](/stack/ctx-compaction)）；
3. **限制步数**：agent 的步数上限直接限制了最坏情况下的成本；
4. **模型分级**：简单的请求用便宜的模型（见[模型分级与 batch](/stack/ai-cost)）；
5. **响应缓存**：重复的确定性请求直接返回缓存的结果；
6. **batch 接口**：离线任务（eval、批量处理）走五折的 batch 接口；
7. **限制输出长度**：设置合理的 `max_tokens`，prompt 里要求简洁。

## 治理：别等账单来了才知道

- **预算和配额**：按 API key、用户、租户设置上限。LLMGateway 按 key 设置每月预算，用完返回 402；免费等级的 key 只能用便宜的模型（见 [LLM 网关](/ai/llm-gateway)）。
- **告警**：花费的增速异常（比如一小时内的花费是平时的 5 倍），往往意味着 bug、死循环的 agent 或者被滥用。
- **每次改动都看成本**：DocPilot 的 eval 会输出总成本，和基线对比时会标出成本是变好还是变坏（见[离线 eval](/stack/ev-offline)）。

## 人力也是成本

「自己做还是买」本质上是成本比较：

- 买现成的服务：按用量付费，但省下了开发和运维的人力；
- 自己做：账单上更便宜，但要算上工程师的时间、值班、长期维护。

LLMGateway 有成熟的替代品可用（LiteLLM、OpenRouter 等）；自托管 GPU 推理往往在账单上看起来便宜，但运维成本很高（见[自托管推理还是调 API](/stack/ai-selfhost)）。

## 追问

::: details 一个后端系统的成本主要由哪几部分组成？哪些容易被忽略？
计算、存储、网络、托管服务、LLM / API 调用费用、人力。容易被忽略的有：出站和跨区域的网络流量；日志量和高基数指标带来的观测费用；无限保留的备份和快照；空闲的资源；以及自建服务所花的工程师时间。
:::

::: details 为什么说 AI 应用的成本结构和传统 SaaS 不同？
传统 SaaS 多服务一个用户的边际成本很低，毛利高。AI 应用每一次对话都要付推理费用，成本随用量线性增长，agent 的多步调用还会让成本超线性增长。如果每个用户产生的 token 费用超过他付的钱，用户越多亏得越多。所以要在设计时就算清单位经济学：每次对话的成本、每个活跃用户的月成本，和收入对比。
:::

::: details 怎么把 LLM 的成本归因到具体的功能和用户？
每一次模型调用都记录 token 和成本，并且带上用户、租户、功能、模型、prompt 版本这些维度（DocPilot 在每轮的 trace 里存 `cost_usd`，LLMGateway 按 API key 统计花费）。价格表要维护，缺少价格的模型要告警，而不是悄悄地按 0 记账。最后按这些维度汇总，找出最贵的功能、用户和改动。
:::

::: details 一个 agent 应用的 LLM 成本太高，你会从哪里下手？
先看成本的构成：agent 场景下输入 token 通常是大头，因为每一步都重发全部历史。优化顺序：prompt caching（固定前缀打折）；控制上下文大小（限制 top_k 和工具返回大小、压缩旧的工具结果）；限制步数；简单请求用便宜的模型；缓存重复的确定性请求；离线任务走 batch 接口；限制输出长度。每一步都用 eval 确认质量没有下降。
:::

::: details 怎么防止 LLM 成本失控？
按 API key、用户、租户设置预算和配额，用完就拒绝（LLMGateway 回 402）；按等级限制可用的模型；agent 设置步数上限；对花费的异常增速告警，因为突增通常意味着 bug、死循环或者滥用；每次 prompt 或模型改动都在 eval 里对比成本。
:::

::: details 云上的计算资源有哪几种购买方式？怎么组合？
按需实例（灵活、最贵）、预留实例或节省计划（承诺一段时间的用量，折扣大）、竞价实例（最便宜，但随时可能被回收）。组合方式：稳定的基线负载用预留，可中断的批处理任务用竞价，波动的部分用按需；没有流量的服务考虑缩容到零。
:::

## 参考

- [FinOps Foundation: FinOps Framework](https://www.finops.org/framework/)
- [AWS Well-Architected: Cost Optimization Pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html)
- [Anthropic: Pricing](https://www.anthropic.com/pricing)、[OpenAI: Pricing](https://openai.com/api/pricing/)
- 实战代码：DocPilot `pricing.py`、`schema.sql`（`traces.cost_usd`）、`api/fly.toml`；LLMGateway `gateway/metrics.py`（`COST`、`COST_SAVED`）、`config/gateway.yaml`（prices）、`gateway/limits.py`（预算）
