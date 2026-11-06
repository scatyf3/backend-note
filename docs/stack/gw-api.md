---
title: Provider API 与结构化输出
---

# Provider API 与结构化输出

这一格是「调模型」的契约。各家 API 的骨架相同（消息进，内容块 + stop_reason + usage 出），但 system prompt 的位置、tool call 的表示（字符串还是对象）、tool result 怎么回传、流式事件、停止原因的命名都不一样。隔离差异有两种做法：应用里定义一个与供应商无关的接口，每家写一个 adapter（DocPilot）；或者在网关统一成 OpenAI 格式（LLMGateway）。结构化输出用 schema 约束解码保证格式合法，但截断、拒答和内容正确性仍要自己处理。

- **让每家用原生格式保存对话**：Anthropic 的 thinking 块带签名，必须原样回传，转成通用格式会丢信息。
- **翻不过去的参数要明确暴露**：LLMGateway 把 `tool_choice: required` 降级成 `auto` 并打告警，prefill 直接回 400。
- **解析结构化输出前先查 stop_reason**：`max_tokens` / `refusal` 时 JSON 可能是半截的（DocPilot judge）。

笔记：[Provider API 与结构化输出](/ai/provider-api-structured-output)

**延伸阅读**：[OpenAI: Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)、[Anthropic: Tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)
