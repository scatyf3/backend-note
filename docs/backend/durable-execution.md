---
title: 工作流与 durable execution：让多步流程崩溃后能接着跑
status: draft
tags: [workflow, durable-execution, temporal, step-functions, saga]
difficulty: 4
order: 14
related: [/backend/background-jobs, /backend/outbox-event-driven, /backend/idempotency, /backend/distributed-transactions, /ai/agent-loop, /ai/long-running-agents]
stack: [mq-workflow]
---

# {{ $frontmatter.title }}

## 一句话结论

一个多步流程（下单 → 扣库存 → 支付 → 发货，或者一个要走几十步的 agent）在中途崩溃时，只有两种糟糕的选择：从头再来（重复执行副作用），或者卡在中间没人管。**durable execution** 的做法是：==把流程里每一步的结果持久化成一份事件历史，进程崩溃后，另一个 worker 重放这份历史，恢复到断点继续执行==。代码写起来像普通的顺序代码，可靠性由引擎提供（Temporal、AWS Step Functions、Azure Durable Functions、Restate、DBOS 等）。代价是两条纪律：**工作流代码必须是确定性的**，**有副作用的步骤（activity）必须幂等**。

## 为什么：多步流程的状态放在哪

用后台任务串起一个多步流程，常见的写法是这样一步步演进的：

1. **一个大任务做完所有步骤**：第 3 步失败重试，前两步又执行一遍（重复扣库存）。
2. **数据库里加状态列 + 定时任务扫描**：`status = 'paid'`，cron 找出卡在某个状态的记录，推进到下一步。能用，但流程逻辑散落在状态机、cron 和各个处理函数里，超时、重试、补偿都要自己写。
3. **队列串联**：每一步完成后，往下一个队列发消息。流程依然是隐式的，「这个订单现在卡在哪一步、为什么」很难回答。

durable execution 把这些都收进一个**显式的、持久化的流程定义**里。

## 以 Temporal 为例

### 两种代码

- **Workflow**：编排逻辑，「先做 A，再做 B，失败了做 C」。它必须是**确定性的**。
- **Activity**：真正有副作用的步骤，调用外部 API、写数据库、调用 LLM。可以失败，由引擎按策略重试，并且有多种超时：单次执行的超时、从排队到完成的总超时、长任务的心跳超时。

```python
@workflow.defn
class OrderWorkflow:
    @workflow.run
    async def run(self, order):
        await workflow.execute_activity(reserve_stock, order, start_to_close_timeout=timedelta(seconds=30))
        try:
            await workflow.execute_activity(charge, order, retry_policy=RetryPolicy(maximum_attempts=5))
        except ActivityError:
            await workflow.execute_activity(release_stock, order)   # 补偿
            raise
        await workflow.sleep(timedelta(days=3))                     # 真的可以睡三天
        await workflow.execute_activity(send_review_email, order)
```

### 怎么做到「崩溃后接着跑」

引擎把 workflow 的每一个关键动作（调度了哪个 activity、activity 的结果、定时器、收到的外部信号）都记进一份**事件历史**。worker 崩溃后：

1. 另一个 worker 拿到这个 workflow 的事件历史；
2. **从头重新执行 workflow 代码**，每当代码要执行一个 activity，就先查历史：如果已经有结果，**直接返回记录下来的结果**，并不会真的再调用一次；
3. 一直重放到历史的末尾，然后从这里开始正常执行。

==所以 workflow 代码必须是确定性的==：重放时，它必须做出和第一次执行完全相同的决定，才能和历史对得上。不能直接读当前时间、用随机数、直接做 IO、开线程，这些都要通过引擎提供的 API（`workflow.now()`、`workflow.random()`）或者放进 activity 里。

### 其他能力

- **长时间等待**：`sleep` 三天、等待一个外部信号，期间不占用任何 worker，到时间或收到信号再恢复。
- **signal 和 query**：外部可以给运行中的 workflow 发信号（「用户审批通过了」），也可以查询它的当前状态。
- **版本化**：改了 workflow 代码之后，还在运行的旧实例重放时会和新代码对不上。要用版本标记（`patched`）让新旧逻辑并存，等旧实例都结束再删掉旧分支。
- **历史大小有上限**：Temporal 的单个执行的事件历史上限是 51,200 个事件或 50 MB，超过会被终止。长期运行的 workflow 要定期用 **continue-as-new** 开启一个新的执行，带上必要的状态，历史从零开始。

### AWS Step Functions

用 JSON（Amazon States Language）定义状态机，而不是写代码。两种类型：

| | Standard | Express |
|---|---|---|
| 最长时间 | 1 年 | 5 分钟 |
| 执行语义 | exactly-once（除非配置了重试） | 异步：at-least-once；同步：at-most-once |
| 适合 | 长流程、非幂等的操作（比如支付） | 高频、短时、幂等的事件处理 |

另一类方案是**基于数据库的轻量实现**，比如 DBOS：把每一步的结果作为检查点写进 Postgres，不需要单独的工作流服务。

## 什么时候用

**适合**：多步骤、跨服务；需要等待（几小时到几天）或人工审批；需要补偿（Saga，见[分布式事务与 Saga](/stack/ds-txn)）；需要清楚地看到「每个实例现在在哪一步」。

**不必用**：单步的后台任务（普通任务队列就够了，见[后台任务](/backend/background-jobs)）；几百毫秒就结束的同步流程；团队还没有准备好遵守确定性的纪律。

代价：学习曲线；确定性的约束容易在不知不觉中被打破（比如用了一个内部调用了 `datetime.now()` 的库）；要运维一个工作流服务（或者用托管服务）；activity 的输入输出都会进历史，要控制大小。

## agent 就是一个需要 durable execution 的工作流

agent 循环和传统的多步流程在结构上一模一样，而且更需要 durable execution：

- **每一步都很贵**：一个跑到第 17 步的 agent 崩溃了，从头再来意味着前 16 次 LLM 调用的钱和时间都白花了。
- **每一步都不确定**：重新跑一遍，模型可能走上另一条路。把每次 LLM 调用作为一个 activity，结果记在历史里，重放时直接用记录的结果，**重放就是确定的**，正好满足 workflow 的确定性要求。
- **有副作用的工具不能重复执行**：发邮件、下单、写文件，重放时不能再执行一次。
- **需要等待人**：「这个操作需要你确认」，可能要等几小时，用 signal 实现，等待期间不占用资源（见[长任务与 human-in-the-loop](/stack/ag-durable)）。

DocPilot 的 agent 循环跑在一次 HTTP 请求的内存里：最多 6 步，几十秒结束，崩溃或断开就丢失。对于问答，这是合理的取舍；但如果要做「读完整个文档库，写一份报告」这种要跑几十分钟的任务，就应该把循环搬进 durable execution 引擎。Temporal 这类引擎也已经开始提供和 agent 框架的集成。

一个更朴素的例子：这个知识库就是一个跑了整夜的写作循环生成的。它的「事件历史」是 git 提交记录加上 `plan.md` 里的勾选状态：每写完一轮就提交并勾掉一项，中断后从第一个没勾的项接着写，已经提交的内容不会重做。这就是手工版的 durable execution：**进度持久化，每一步可以安全地重做**。

## 追问

::: details durable execution 解决了什么问题？和普通的任务队列有什么区别？
它解决的是多步流程中途崩溃之后，既不能从头重来（重复副作用），又不能卡在中间的问题。任务队列只保证单个任务能被执行和重试，多步之间的状态、顺序、超时、补偿都要自己用状态列和 cron 拼起来。durable execution 把整个流程定义成一段代码，每一步的结果持久化成事件历史，崩溃后重放恢复到断点，还内置了长时间等待、外部信号、超时和重试。
:::

::: details Temporal 是怎么在 worker 崩溃后恢复 workflow 的？
引擎把每个 workflow 的关键事件（调度了哪个 activity、activity 的结果、定时器、收到的信号）记进事件历史。新的 worker 拿到历史后，从头重新执行 workflow 代码；遇到已经有结果的 activity，直接返回记录下来的结果，不会真的再执行；重放到历史末尾后，继续正常执行。
:::

::: details 为什么 workflow 代码必须是确定性的？哪些写法会破坏确定性？
恢复靠的是重放：workflow 代码重新执行一遍时，必须做出和第一次完全相同的决定，才能和事件历史对得上。破坏确定性的写法：直接读取当前时间、使用随机数、直接调用外部服务或读文件、开线程、遍历顺序不确定的集合，以及修改了代码却没有做版本化。这些要通过引擎的 API（`workflow.now()`）或者放进 activity 里。
:::

::: details workflow 和 activity 分别放什么？activity 为什么要幂等？
workflow 放编排逻辑：顺序、分支、等待、补偿，必须确定、不能有副作用。activity 放有副作用的操作：调 API、写数据库、调用 LLM，可以失败、由引擎重试。activity 执行成功但结果还没被记录下来时，worker 崩溃了，引擎会再执行一次，所以 activity 要幂等（比如用 workflow id 加步骤名作为幂等 key）。
:::

::: details 线上还有几千个正在运行的 workflow 实例，这时要修改 workflow 代码，怎么办？
直接改代码，旧实例重放时会和历史对不上（非确定性错误）。要用版本化：在代码里加一个版本标记（Temporal 的 `patched`），旧实例走旧分支，新实例走新分支；等所有旧实例都结束后，再删掉旧分支。另一种办法是用新的 workflow 类型承接新的执行，旧类型保留到旧实例跑完。
:::

::: details 为什么说 agent 特别适合用 durable execution 来运行？
1. 每一步（LLM 调用）都贵，崩溃后从头再来会浪费前面所有的花费；
2. LLM 的输出不确定，把每次调用作为 activity、结果记入历史，重放时直接用记录的结果，就是确定的；
3. 有副作用的工具不能在重放时重复执行；
4. 等待人工审批可能要几小时，用 signal 等待，不占资源；
5. 每个 agent 实例在哪一步、调用了什么，都能直接查到。
:::

## 参考

- [Temporal: Workflows](https://docs.temporal.io/workflows)、[Temporal: Continue-As-New](https://docs.temporal.io/develop/dotnet/continue-as-new)、[Managing very long-running Workflows](https://temporal.io/blog/very-long-running-workflows)（事件历史上限 51,200 个事件 / 50 MB）
- [AWS Step Functions: Choosing workflow type](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)（Standard 最长 1 年、Express 最长 5 分钟）
- [Azure Durable Functions: Orchestrator code constraints](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-code-constraints)
- [DBOS: Durable execution in Postgres](https://docs.dbos.dev/)
- 实战代码：DocPilot `api/src/docpilot/agent/loop.py`（内存中的循环）、`routes/chat.py`
