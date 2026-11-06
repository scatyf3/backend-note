---
title: 模型分级与 batch：不是每个请求都需要最强的模型
status: draft
tags: [model-routing, cascade, cost, batch-api, distillation]
difficulty: 3
order: 22
related: [/ai/llm-latency-cost, /ai/llm-gateway, /backend/cost, /ai/offline-evals, /ai/interaction-patterns, /ai/self-host-vs-api]
stack: [ai-cost]
---

# {{ $frontmatter.title }}

## 一句话结论

==不是每个请求都需要最强的模型==。降低成本有四类做法：

- **模型分级（路由）**：按请求的难度和价值，分给不同档次的模型；
- **级联**：先用便宜的模型，结果不够好再升级到贵的；
- **蒸馏或微调**：把大模型在某个窄任务上的能力迁移到小模型；
- **batch 接口**：离线任务打五折，代价是最长 24 小时内返回。

这些做法都有一个前提：要有 eval 衡量每一档的质量，并且按**完成一次任务的成本**来比较，而不是只看单价。便宜的模型如果要多试几次才能成功，未必真的便宜。

## 为什么要分级

模型之间的价差非常大。以 LLMGateway 配置里的价格表为例（每百万 token，美元，以官方价格为准）：

| 模型 | 输入 | 输出 |
|---|---|---|
| claude-haiku-5-5 | 0.10 | 0.50 |
| gpt-4.1-mini | 0.40 | 1.60 |
| claude-sonnet-5-5 | 2.00 | 10.00 |
| gpt-4.1 | 2.00 | 8.00 |
| claude-opus-5-5 | 4.00 | 20.00 |

最便宜和最贵的输入价差了 40 倍。而一个产品的流量里，往往有大量简单的请求：分类、抽取、改写、简单问答。全部用最强的模型，大部分钱花在了不需要那么强的地方。

## 路由：按请求分给不同的模型

### 静态路由：按功能

最简单也最常用：不同的功能固定使用不同的模型。

- 意图分类、抽取字段、检查格式 → 小模型；
- 复杂推理、写长文、多步的 agent → 大模型；
- 离线批处理 → 便宜的模型或 batch 接口。

### 规则路由：按请求的特征

LLMGateway 已经实现了两种：

- **按 prompt 长度**：超过 3000 token 的 `fast` / `cheap` 请求，改走自托管的 vLLM。长 prompt 的成本主要在 prefill，而 vLLM 的 prefix caching 能让重复的长前缀几乎免费。规则只作用于 `fast` 和 `cheap`，调用方明确要 `smart` 或 `best` 时不擅自降级。
- **按调用方的等级**：免费等级的 key 只能使用便宜的别名，请求了不允许的模型就降级到默认别名，原因写进 `x-gateway-route` 响应头（见 [LLM 网关](/ai/llm-gateway)）。

### 学习型路由

训练一个小的分类器，预测「这个请求用小模型能不能答好」，能就用小模型，不能就用大模型。RouteLLM 这类研究表明，在质量损失很小的情况下，可以把相当一部分请求转给便宜的模型。代价是要准备训练数据（哪些请求小模型答得好），并持续监控路由的效果。

## 级联：先便宜，不够再升级

```
请求 → 小模型 → 验证 → 通过 → 返回
                  ↓ 不通过
                大模型 → 返回
```

关键在**验证**：

- **确定性的检查**：输出是否符合 JSON schema、引用是否都能在数据库里查到、是否触发了拒答；
- **置信度**：logprobs、多次采样的一致性（见[采样与非确定性](/ai/sampling-nondeterminism)）；
- **judge**：再用一个模型判断质量，但这会增加成本和延迟。

级联划算的条件是：**大部分请求在第一级就能通过**，而且验证本身很便宜。如果大部分请求最后都要升级，级联反而比直接用大模型更贵、更慢（FrugalGPT 等研究讨论过这类权衡）。

## agent 里每一步都可以用不同的模型

agent 的各个步骤，难度并不一样：

- 决定调用哪个工具、改写搜索词：小模型通常就够了；
- 综合多个来源写最终答案：需要更强的模型。

DocPilot 目前所有步骤都用同一个模型。按步骤分级是一个可以尝试的优化，但要在 eval 上确认：小模型选错工具、搜错关键词，会让后面的步骤全部变差，可能得不偿失。

### 推理深度也是一个旋钮

同一个模型内部也能分级。DocPilot 回答问题时用 `effort: medium`，judge 用 `effort: low`。effort 越高，thinking 的 token 越多，延迟和成本越高。对于不需要深度推理的任务，调低 effort 是最便宜的优化，不用换模型，也不用改架构。

## 蒸馏和微调

对于一个量很大、范围很窄的任务（比如把用户的问题分成 20 类），可以用大模型生成一批高质量的标注，再用它们微调一个小模型。之后这个任务就由小模型（甚至自托管的模型）来完成，成本和延迟都大幅下降。代价是：要维护训练数据和训练流程；任务的定义一变，就要重新训练；仍然要用 eval 持续监控质量（见[自托管推理还是调 API](/stack/ai-selfhost)）。

## batch 接口

主流供应商都提供 batch 接口：一次提交大量请求，**最长 24 小时内**返回结果，**价格五折**。适合：

- **离线 eval**：DocPilot 每次运行要对 110 道题调用 judge，这些调用不需要实时返回，非常适合改用 batch 接口（见[离线 eval](/stack/ev-offline)）；
- **批量打标、分类、摘要**；
- **回填 embedding**：换了 embedding 模型，需要把整个语料重新算一遍（见 [Embedding 与向量索引](/stack/st-vector)）；
- **每晚的报告**。

代价是延迟不可控，结果要逐条处理（有些会失败，需要重新提交），也没法用于任何需要实时交互的场景（见[交互模式](/ai/interaction-patterns)）。

## 怎么评估分级的决策

- **按每次成功完成任务的成本比较**：小模型单价低，但如果失败率高、需要重试或升级，总成本未必更低。
- **每一档都在同一个 eval 上测**：正确率、引用忠实度、延迟、成本，放在一张表里对比。
- **级联要监控升级率**：升级率越来越高，说明第一级的模型已经不够用了，或者请求的分布变了。
- **路由要能回放**：线上的路由决策和结果都记进 trace，定期抽查「被分给小模型的请求，答得怎么样」。

## 追问

::: details 为什么要做模型分级？
不同模型的价差可以达到几十倍（LLMGateway 价格表里最便宜和最贵的输入价差 40 倍），而大量请求是简单的分类、抽取、改写，用不着最强的模型。全部用最强的模型，钱主要花在不需要的地方。分级让简单请求用便宜的模型，复杂请求用强模型，前提是用 eval 确认每一档的质量。
:::

::: details 模型路由有哪几种做法？
1. 静态路由：按功能固定模型，最简单；
2. 规则路由：按请求特征，比如 LLMGateway 把超过 3000 token 的 `fast` / `cheap` 请求转到自托管的 vLLM，按 key 的等级限制可用的模型；
3. 学习型路由：训练分类器预测小模型能否答好（RouteLLM 一类的方法）。

越往后越灵活，也越需要训练数据和监控。
:::

::: details 什么是模型级联？它在什么条件下才划算？
先用便宜的模型生成结果，验证通过就返回，不通过再交给大模型。划算的条件：大部分请求在第一级就能通过，并且验证本身很便宜（schema 校验、引用校验、置信度）。如果多数请求最后都要升级，或者验证要再调用一次模型，级联反而比直接用大模型更贵、更慢。要监控升级率。
:::

::: details agent 的每一步都应该用同一个模型吗？
不一定。决定调用哪个工具、改写搜索词这类步骤，小模型往往够用；综合多个来源写最终答案需要强模型。但小模型选错工具、搜错关键词会让后续步骤全部变差，所以要在 eval 上验证。另一个更便宜的旋钮是推理深度：DocPilot 回答用 `effort: medium`，judge 用 `low`。
:::

::: details 什么时候考虑蒸馏或微调一个小模型？
任务量很大、范围很窄、定义稳定的时候，比如固定类别的分类、格式固定的抽取。用大模型生成高质量的标注，再微调小模型，成本和延迟都能大幅下降，还可以自托管。代价是要维护训练数据和流程，任务定义变了要重新训练，并且要持续用 eval 监控质量。
:::

::: details batch 接口适合什么场景？有什么代价？
不需要实时结果、量大的任务：离线 eval（DocPilot 每次要调用 110 次 judge）、批量打标、换模型后回填 embedding、每晚的报告。主流供应商给五折。代价是最长 24 小时才返回，延迟不可控，结果要逐条处理，失败的要重新提交，不能用于交互场景。
:::

::: details 怎么判断「换成小模型」这个决策是不是对的？
按每次成功完成任务的成本比较，而不是只看单价：小模型失败率高、需要重试或升级时，总成本未必更低。在同一个 eval 上对比各档的正确率、忠实度、延迟和成本；上线后记录路由决策和结果，抽查被分给小模型的请求的质量；级联场景监控升级率的变化。
:::

## 参考

- Ong et al., [RouteLLM: Learning to Route LLMs with Preference Data](https://arxiv.org/abs/2406.18665)
- Chen et al., [FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance](https://arxiv.org/abs/2305.05176)
- [Anthropic: Message Batches](https://docs.anthropic.com/en/docs/build-with-claude/batch-processing)、[OpenAI: Batch API](https://platform.openai.com/docs/guides/batch)
- [Anthropic: Choosing a model](https://docs.anthropic.com/en/docs/about-claude/models/choosing-a-model)
- 实战代码：LLMGateway `config/gateway.yaml`（aliases、rules、tiers、prices）、`gateway/router.py`（`resolve`）；DocPilot `config.py`（`anthropic_effort`）、`evals/judge.py`（`JUDGE_EFFORT`）
