---
title: 自托管推理还是调 API
---

# 自托管推理还是调 API

调 API 按 token 付费、零运维、能用最强的模型；自托管按 GPU 小时付费、可控、数据不出域。自托管划算的关键是利用率：每百万 token 成本 = GPU 时价 ÷（每秒 token 数 × 利用率 × 3600）× 10⁶，空闲的 GPU 照样收费，再加上运维人力，API 往往更便宜。适合自托管的场景：流量大且稳定、任务窄、长前缀重复多（prefix caching）、合规要求数据不出域、需要微调。最常见的答案是混合部署。

- **LLMGateway 的混合部署**：vLLM 排在 `cheap` / `local` 链的最前面，API 作为 fallback；超过 3000 token 的请求路由到本地，利用 prefix caching 的收益。
- **自托管不是免费的**：价格表里给自托管模型填上摊销后的 GPU 成本，成本对比和路由决策才公平。
- **prefix caching 的对照实验**：随机串放在 system prompt 开头，请求串行发送，绕过网关缓存。

笔记：[自托管推理还是调 API](/ai/self-host-vs-api)

**延伸阅读**：[vLLM / PagedAttention](https://arxiv.org/abs/2309.06180)、[vLLM 文档](https://docs.vllm.ai/)
