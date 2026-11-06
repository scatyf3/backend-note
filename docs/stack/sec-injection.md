---
title: Prompt injection
---

# Prompt injection

prompt injection 是不可信的文本被模型当成指令执行。直接注入是用户自己越狱；间接注入藏在模型会读到的文档、网页、邮件、工具结果里，用户毫不知情就被利用，危害更大。LLM 把指令和数据放在同一串 token 里，没有参数化查询那样的硬边界，所以无法根除，只能分层缓解：降低成功率（分隔、声明、指令层级、检测），降低成功后的影响（最小权限、人工确认、切断外泄通道、双 LLM 模式），检测和审计。

- **致命三要素**：私有数据 + 不可信内容 + 对外通信，去掉任一个，外泄路径就断了。markdown 图片是隐蔽的外泄通道。
- **DocPilot 缺第三个要素**：没有对外发送的工具，回答按纯文本渲染，主要风险是答案被操纵和通过 `create_page` 污染文档库。
- **最可靠的那一层不依赖模型**：权限和确认要在模型之外强制执行。

笔记：[Prompt injection：数据被当成了指令](/ai/prompt-injection)

**延伸阅读**：[The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)、[Indirect Prompt Injection](https://arxiv.org/abs/2302.12173)
