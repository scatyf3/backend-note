---
title: Guardrails
---

# Guardrails

guardrails 是模型之外、包在模型调用两侧的强制检查：输入侧（越狱和注入检测、PII 脱敏、话题范围、长度限制）、输出侧（结构校验、引用校验、敏感内容过滤）、执行侧（工具参数和权限校验）。能用规则就不用模型，能用小模型就不用大模型；流式输出和输出检查有冲突，要选择事后附加、按句缓冲或者先检查再输出；检查失败后的动作（拒绝、脱敏、重试、模板、转人工）要事先设计好。guardrails 也会误报，需要用正常请求和对抗样本来评估。

- **很多有效的 guardrails 就是普通的校验**：DocPilot 的 pydantic 参数校验、被截断的 tool call 不执行、引用回库校验、确定性的拒答检测。
- **事后附加的检查和流式兼容**：DocPilot 的引用校验结果放在流的末尾，只做补充，不撤回文字。
- **通用检查放网关，依赖业务语境的检查放应用**。

笔记：[Guardrails：包在模型两侧的检查](/ai/guardrails)

**延伸阅读**：[Llama Guard](https://arxiv.org/abs/2312.06674)、[NeMo Guardrails](https://docs.nvidia.com/nemo/guardrails/)
