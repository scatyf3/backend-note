---
title: 延迟与成本模型
---

# 延迟与成本模型

这一格回答「一次 LLM 调用要多久、花多少钱」。延迟分两段：TTFT ≈ 排队 + prefill，随输入长度增长、瓶颈是算力；decode 每出一个 token 都要读一遍全部权重、瓶颈是显存带宽，所以总延迟 ≈ TTFT + 输出 token 数 × TPOT。计价按输入、输出分开，输出贵 4–5 倍。但 agent 每一步都重发历史，账单的大头通常是输入。

- **流式输出让 TTFT 成了体验的关键**；thinking token 不可见，但占时间、按输出计费。
- **agent 场景先做 prompt caching 和压缩**，再考虑换模型；离线任务走 Batch API（五折）。
- **成本要逐次记录**：DocPilot 把 token 和 `cost_usd` 写进每一轮的 trace，LLMGateway 在响应头里返回 `x-gateway-cost-usd`。

笔记：[延迟与成本模型](/ai/llm-latency-cost)

**延伸阅读**：[Transformer Inference Arithmetic](https://kipp.ly/transformer-inference-arithmetic/)、[Anthropic: Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
