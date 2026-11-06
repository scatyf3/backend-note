---
title: Tool calling 与 MCP
---

# Tool calling 与 MCP

这一格是「让模型调你」的契约。模型只输出一个调用意图（工具名 + JSON 参数），执行的永远是应用代码，结果再作为消息回传，所以工具定义就是写给模型的 API 文档，执行权和安全边界都在应用这一侧。MCP 把工具的提供方标准化：一个 server 通过 JSON-RPC（stdio 或 Streamable HTTP）暴露 tools / resources / prompts，任何宿主都能接入。代价是第三方 server 带来 tool poisoning、权限过大这类新的攻击面。

- **一个 pydantic 模型同时生成 schema 和做校验**，schema 和校验不会对不上（DocPilot `tools.py`）。
- **工具出错要回传给模型**（`is_error=True` 加上具体原因），不要中断回合，模型会自己修正。
- **MCP 和 function calling 是两层**：前者管工具从哪来、怎么调过去，后者管模型怎么表达调用。

笔记：[Tool calling 与 MCP](/ai/tool-calling-mcp)

**延伸阅读**：[Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)、[MCP 规范](https://modelcontextprotocol.io/specification)
