---
title: 工作流与 durable execution
---

# 工作流与 durable execution

多步流程中途崩溃时，既不能从头重来（会重复副作用），也不能卡在中间。durable execution 把每一步的结果持久化成事件历史，崩溃后由另一个 worker 重放历史、恢复到断点继续。代码写起来像普通的顺序代码，还内置了长时间等待、外部信号、超时和重试（Temporal、Step Functions、Durable Functions、DBOS）。代价是两条纪律：workflow 代码必须确定，activity 必须幂等；改代码时要做版本化，历史过长时要 continue-as-new（Temporal 上限是 51,200 个事件或 50 MB）。

- **重放时，已完成的 activity 直接返回记录下来的结果**，所以 workflow 里不能直接读时间、用随机数或做 IO。
- **Step Functions**：Standard 最长 1 年、exactly-once；Express 最长 5 分钟、at-least-once。
- **agent 天然需要 durable execution**：LLM 调用贵且不确定，记录下来重放就是确定的；人工审批靠 signal 等待。

笔记：[工作流与 durable execution](/backend/durable-execution)

**延伸阅读**：[Temporal: Workflows](https://docs.temporal.io/workflows)、[Step Functions: Choosing workflow type](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)
