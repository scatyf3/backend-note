---
title: 采样、非确定性与幻觉
---

# 采样、非确定性与幻觉

LLM 每一步输出下一个 token 的概率分布，再按 temperature / top-p 等参数**采样**，所以同一个 prompt 每次结果不同是设计使然。temperature = 0 也不保证确定：推理服务的 batch 组成会改变浮点归约顺序，翻转接近的 argmax。幻觉来自同一机制，模型生成的是「看起来合理」的 token。对后端来说，这意味着 LLM 调用不是纯函数：测试要断言性质而不是字符串，重试拿到的是另一个样本，缓存会冻结一次随机抽样。

- **网关默认只缓存 temperature = 0 的请求**（LLMGateway 的 `is_cacheable`），`n > 1` 不缓存。
- **新的推理模型不再接受 temperature / top_p**，「设 0 保稳定」的习惯越来越不成立。
- **幻觉要做到可检测**：DocPilot 让模型引用 chunk id，再回数据库校验，查不到的 id 不产生引用。

笔记：[采样、非确定性与幻觉](/ai/sampling-nondeterminism)

**延伸阅读**：[Defeating Nondeterminism in LLM Inference](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/)、[Why Language Models Hallucinate](https://arxiv.org/abs/2509.04664)
