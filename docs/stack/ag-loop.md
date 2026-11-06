---
title: Agent 循环
---

# Agent 循环

agent 循环是一个 while 循环：调用模型，有 tool call 就执行并回传结果，再调用模型，直到给出最终答案或触发停止条件。逻辑只有十几行，难点在边界：先看 `stop_reason`（被截断的 tool call 不能执行）；步数、时长、成本都要有上限；同一轮的工具并发执行，错误回传而不中断；每一步都流式推给用户并记进 trace。更重要的判断是：步骤固定时用 workflow，只有路径事先无法确定时才用 agent。

- **DocPilot 的循环**：最多 6 步；到上限仍想调工具就标记 `finish_reason = "other"`；循环本身不依赖 HTTP 和 provider，能直接单测。
- **还缺的上限**：总时长 deadline、成本预算、单个工具的超时。
- **常见失败**：重复调用、不检索就编造、错误被忽略；靠上限、prompt 和 trace 来发现和约束。

笔记：[Agent 循环：停止条件、上限与工具执行](/ai/agent-loop)

**延伸阅读**：[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)、[ReAct](https://arxiv.org/abs/2210.03629)
