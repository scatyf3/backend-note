---
title: 长任务与 human-in-the-loop
---

# 长任务与 human-in-the-loop

跑几分钟到几小时的 agent 不能绑在一次 HTTP 请求上：连接会断、进程会重启、用户不会一直等着，中途还可能需要等人审批。做法是让 run 成为一等公民（有 id、状态、事件流），执行放进持久化的运行时，每一步做检查点，HTTP 只负责创建任务、查询状态和订阅事件（支持 `Last-Event-ID` 断线续传）。human-in-the-loop 用「暂停 → 等待 → 恢复」实现：有风险的操作先挂起，批准后执行被批准的那组参数，被拒绝就把原因回传给模型，超时就执行安全的默认动作。

- **按风险给工具分级**：只读自动执行，可逆写操作自动或事后确认，不可逆或对外的操作必须事前批准，避免审批变成橡皮图章。
- **批准要绑定到具体参数**：用参数哈希比对，防止批准之后参数又被改了。
- **恢复时不重复副作用**：用 `(run_id, tool_call_id)` 做幂等 key，LLM 的输出也要记录下来。

笔记：[长任务与 human-in-the-loop](/ai/long-running-agents)

**延伸阅读**：[LangGraph: Human-in-the-loop](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/)、[Temporal: Signals](https://docs.temporal.io/sending-messages#sending-signals)
