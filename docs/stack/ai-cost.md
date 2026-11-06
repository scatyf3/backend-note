---
title: 模型分级与 batch
---

# 模型分级与 batch

不是每个请求都需要最强的模型：模型之间的价差可达几十倍，而大量请求是简单的分类、抽取、改写。做法有：按功能、规则或学习型分类器路由；级联（先便宜再升级，前提是大部分请求在第一级通过、验证便宜）；agent 按步骤选模型、调推理深度；对窄任务蒸馏或微调小模型；离线任务走 batch 接口（五折，最长 24 小时）。所有决策都要用 eval 验证，按每次成功完成任务的成本比较，而不是只看单价。

- **LLMGateway 已有的规则路由**：超过 3000 token 的 `fast` / `cheap` 请求转到自托管的 vLLM；免费等级只能用便宜的别名。
- **effort 是最便宜的旋钮**：DocPilot 回答用 medium，judge 用 low。
- **DocPilot 的 eval 天然适合 batch**：110 次 judge 调用不需要实时返回。

笔记：[模型分级与 batch](/ai/model-tiering-batch)

**延伸阅读**：[RouteLLM](https://arxiv.org/abs/2406.18665)、[FrugalGPT](https://arxiv.org/abs/2305.05176)
