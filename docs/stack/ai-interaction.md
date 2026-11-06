---
title: 同步 / 异步交互模式
---

# 同步 / 异步交互模式

交互模式由两个时间决定：用户愿意等多久、任务实际要跑多久，还要看结果是给人看还是给程序用。一秒内用同步；几秒到一分钟、有人在看的用流式；几分钟用异步任务（202 加轮询或推送）；几小时、可能要审批的用后台 agent；不急的用 batch（五折）。每种模式对应不同的基础设施和失败处理方式，事后切换要改接口契约、前端状态和测试，所以设计时就要预估任务时长的上限。

- **让等待可见**：DocPilot 的流里除了文字还有工具步骤事件，前端能显示「正在搜索」；异步任务要显示进度并在完成后通知。
- **DocPilot 的模式盘点**：聊天用流式（合适），上传是同步的（应改异步），eval 天然适合 batch。
- **程序消费结构化结果时用非流式**更简单；LLMGateway 的流式和非流式请求共享缓存。

笔记：[同步 / 异步交互模式](/ai/interaction-patterns)

**延伸阅读**：[Response Times: The 3 Important Limits](https://www.nngroup.com/articles/response-times-3-important-limits/)、[Anthropic: Message Batches](https://docs.anthropic.com/en/docs/build-with-claude/batch-processing)
