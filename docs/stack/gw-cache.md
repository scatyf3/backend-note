---
title: Prompt caching 与语义缓存
---

# Prompt caching 与语义缓存

这一格是 LLM 应用的三层缓存。provider 的 prompt caching 复用相同前缀的 KV cache，省 prefill 的时间和大部分输入费用，不改变输出；网关的 exact cache 对规范化后完全相同的请求直接返回旧响应；语义缓存在问题意思相近时复用答案，命中率最高，但有误命中风险。越往后省得越多、风险越大，所以 prompt caching 应该默认用上，语义缓存要用严格的阈值和隔离的命名空间约束。

- **prompt 按变化频率从低到高排**：工具 → system → 文档 → 历史 → 新消息；时间戳、不稳定的 JSON 序列化会悄悄破坏缓存。DocPilot 目前没有设置 `cache_control`。
- **exact cache 的 key 排除 `stream` / `user`**，流式和非流式共享一份缓存；只缓存 temperature 0、n = 1 的请求。
- **语义缓存**：只 embed 最后一条用户消息，system prompt 和历史进命名空间；带工具的请求跳过；阈值 0.95，每次命中都写审计日志。

笔记：[Prompt caching 与语义缓存](/ai/prompt-semantic-cache)

**延伸阅读**：[Anthropic: Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)、[vLLM: Automatic Prefix Caching](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching.html)
