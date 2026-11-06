---
title: Prompt 设计与版本管理
---

# Prompt 设计与版本管理

prompt 是代码：它决定行为，改一句就可能回归，和解析输出的代码、使用的模型版本都耦合在一起。所以要放进版本控制，改动自动触发 eval，trace 里记录 prompt 版本。好的 system prompt 交代五件事：身份和范围、工作流程（什么时候用哪个工具）、输出格式（附例子）、边界（不知道时怎么说）、数据和指令的区分。prompt 的表面积还包括工具描述、工具结果的格式和错误信息。

- **拒答句是 prompt 和代码共享的常量**：DocPilot 的 `REFUSAL` 同时用于 prompt、`is_refusal` 检测和 fake provider，拒答才能被确定性地度量。
- **改 `prompts.py` 会触发 CI eval**，并把与 baseline 的差异贴到 PR 评论里；DocPilot 的 trace 还缺 prompt 版本这个字段。
- **拼进 prompt 的数据要转义**：`format_chunk` 会替换标题里的双引号，防止破坏 `<chunk>` 标签。

笔记：[Prompt 设计与版本管理](/ai/prompt-versioning)

**延伸阅读**：[Anthropic: Prompt engineering overview](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview)、[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
