---
title: 离线 eval 与 LLM-as-judge
---

# 离线 eval 与 LLM-as-judge

eval 是 LLM 应用的测试：固定数据集、自动打分、和基线对比，每次改 prompt、模型、检索时都运行。数据集要覆盖难例（多跳题、无答案题），标签要经得起改动（用原文片段标注），检索和生成分开评估，能用确定性规则判断的就不用模型。LLM-as-judge 要用二元判断、参考答案和人工抽查来校准；看结果时要考虑噪声，110 道题的数据集，95% 置信区间大约是 ±7.5 个百分点。

- **DocPilot 用虚构公司的 wiki 做语料**，模型没法靠训练数据答对；`evals.dataset` 在 CI 里校验每条原文片段都存在。
- **每个指标都要想清楚分母**：引用忠实度只在没有拒答的回答上算，否则拒答越多分越高。
- **CI 里和 baseline 对比**：配置不一致时提示差值不可比；缺少密钥时降级运行，并在评论里写明。

笔记：[离线 eval 与 LLM-as-judge](/ai/offline-evals)

**延伸阅读**：[Your AI Product Needs Evals](https://hamel.dev/blog/posts/evals/)、[Judging LLM-as-a-Judge](https://arxiv.org/abs/2306.05685)
