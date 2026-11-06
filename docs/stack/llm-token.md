---
title: Token 与上下文窗口
---

# Token 与上下文窗口

token 是 LLM 的计量单位，计费、限流、上下文上限、延迟都按它算。token 是 BPE 一类算法切出的子词，英文约 0.75 词一个 token，其他语言差异大，而且每家 tokenizer 不同。上下文窗口是输入和输出共用的上限，受 KV cache 显存（每个 token 每层都要存 K、V）、$O(n^2)$ 的 prefill 计算和训练长度共同约束。窗口能塞下不代表用得好：信息放在中间时模型容易忽略（lost in the middle）。

- **估算可以粗，计费必须准**：网关限流按约 4 字符 / token 粗估，计费用供应商返回的 usage。
- **agent 每一步都重发完整历史**，输入 token 随步数近似平方增长，要靠 prompt caching 和压缩控制。
- **「0.75 词 / token」只是英文经验值**：DocPilot 的切分器按空格数词，碰到中文会严重低估 chunk 大小。

笔记：[Token 与上下文窗口](/ai/tokens-context-window)

**延伸阅读**：[tiktoken](https://github.com/openai/tiktoken)、[Lost in the Middle](https://arxiv.org/abs/2307.03172)
