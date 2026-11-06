---
title: 成本
---

# 成本

后端成本 = 计算 + 存储 + 网络 + 托管服务 + 人力。AI 应用里，LLM 的 token 费用往往是最大的单项，而且随用量线性、随 agent 步数超线性增长，所以要在设计时就算清单位经济学（每次对话的成本 vs 收入）。成本工程分三步：度量（归因到请求、功能、用户、模型、prompt 版本）、优化（先找最大头）、治理（预算、配额、异常告警）。容易被忽略的有出站和跨区域流量、观测费用和自建服务的人力。

- **每次调用都记成本**：DocPilot 的 trace 存 `cost_usd`；LLMGateway 按 key 统计花费，还记录缓存省下的钱。
- **agent 成本的优化顺序**：prompt caching → 控制上下文 → 限制步数 → 模型分级 → 响应缓存 → batch → 限制输出。
- **价格表是要维护的代码**：缺少价格按 0 记账会悄悄低估成本，要告警。

笔记：[成本：度量、归因与优化](/backend/cost)

**延伸阅读**：[FinOps Framework](https://www.finops.org/framework/)、[AWS Well-Architected: Cost Optimization](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html)
