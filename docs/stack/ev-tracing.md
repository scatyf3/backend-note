---
title: LLM tracing
---

# LLM tracing

LLM trace 记录一个回答是怎么来的、花了多少：模型和 prompt 版本，每一步模型调用的 token、TTFT 和结束原因，每次工具调用的参数、摘要、耗时、错误，检索到的内容 id，最终的输出、引用和成本。它是排查错误回答、归因成本、采集 eval 数据和事后审计的基础，和分布式追踪互补，可以用 OpenTelemetry 的 GenAI 语义约定统一字段，用同一个 trace id 关联网关和应用两层。

- **DocPilot 每轮存一行 trace**，和回答在同一个事务里写入；只存 chunk id，查看时再关联原文，删除文档后原文自然消失。
- **还缺的部分**：每一步的明细、TTFT、prompt 版本、结束原因；出错和断开的轮次根本没有 trace。
- **trace 里有用户数据**：最小化存储、设置保留期、做访问控制，并且跟随删除。

笔记：[LLM tracing：每个回答是怎么来的、花了多少](/ai/llm-tracing)

**延伸阅读**：[OpenTelemetry GenAI 语义约定](https://opentelemetry.io/docs/specs/semconv/gen-ai/)、[Langfuse: Tracing](https://langfuse.com/docs/tracing)
