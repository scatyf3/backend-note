---
title: 长任务与 human-in-the-loop：把 agent 从请求里解放出来
status: draft
tags: [agent, long-running, human-in-the-loop, approval, durable-execution]
difficulty: 4
order: 13
related: [/ai/agent-loop, /backend/durable-execution, /backend/background-jobs, /backend/streaming-sse-websocket, /backend/idempotency, /ai/agent-sandbox]
stack: [ag-durable]
---

# {{ $frontmatter.title }}

## 一句话结论

跑几分钟到几小时的 agent，不能绑在一次 HTTP 请求上。要把**执行**放进一个持久化的运行时：每个任务（run）有自己的 id、状态和事件流，客户端随时订阅、断线重连；每一步都做检查点，崩溃后从断点恢复；设置步数、成本和时间上限。**human-in-the-loop** 则用「暂停 → 等待人 → 恢复」来实现：==在执行有风险的操作之前把 run 挂起，提出具体的动作等人批准；批准信号到了再继续，被拒绝就把拒绝原因作为工具结果交给模型，超时就执行一个安全的默认动作==。

## 为什么不能在一次请求里跑完

DocPilot 的 agent 在一次 `/chat` 请求里跑完：最多 6 步，几十秒结束。这对问答是合理的，但换成「读完整个文档库，写一份季度总结」这种任务，问题就都冒出来了：

- **连接撑不住**：代理和负载均衡的超时（见[网络](/backend/network-tcp-http-tls)），用户关掉页面，手机切换网络，都会断开连接。
- **进程撑不住**：跑一小时，期间可能赶上部署、扩缩容、崩溃。DocPilot 的循环状态只在内存里，进程一没，前面所有步骤（和花掉的钱）都白费了。
- **用户不会一直等着**：他们希望离开，做完了再通知他们。
- **中途需要人**：「要删除 30 个文档，确认吗？」可能要等几个小时才有人回复，不能一直占着一个 worker 和一个模型连接。

## 架构：run 是一等公民

```
POST /runs                 → 202 {run_id}              创建任务，放进持久化的运行时
GET  /runs/{id}            → {status, progress, cost}  查询状态
GET  /runs/{id}/events     → SSE，支持 Last-Event-ID   订阅事件流，断线重连后补发
POST /runs/{id}/approvals  → 批准或拒绝某个待审批的动作
POST /runs/{id}/cancel     → 取消
```

**状态**：`queued → running ⇄ waiting_for_input → succeeded | failed | cancelled`

**执行**：worker 把 agent 循环作为一个 durable workflow 来运行，每一次 LLM 调用和工具调用都是一个可以重试、结果会被记录的步骤（见[工作流与 durable execution](/backend/durable-execution)）。

**事件**：每一步产生的事件（文本片段、工具调用、工具结果、需要审批）带着递增的 id，追加写进一个事件日志（数据库表或 Redis Stream）。HTTP 连接只是这个日志的一个订阅者，断开重连后从 `Last-Event-ID` 之后继续读（见[流式接口](/backend/streaming-sse-websocket)）。

==执行和连接解耦之后，「用户断开」「进程重启」「等待审批」都只是 run 生命周期里的普通事件==，而不是需要特殊处理的事故。

## 检查点与恢复

- **每一步之后持久化**：消息历史、已经执行过的工具调用及其结果、累计的 token 和成本。
- **恢复时不重复副作用**：durable execution 引擎会直接复用已记录的步骤结果。自己实现的话，要给有副作用的工具一个幂等 key，比如 `(run_id, tool_call_id)`，执行之前先检查是否已经做过（见[幂等](/backend/idempotency)）。
- **LLM 调用的结果也要记录**：模型的输出不确定，重新调用一次可能走上另一条路，记录下来才能确定地恢复。

## 预算、进度与取消

- **三种上限一起设**：步数、token / 成本、总时长。接近上限时，可以让 agent 先总结已有的结果，而不是直接中断（部分结果总比什么都没有好）。
- **进度要可见**：当前在第几步、做什么、已经花了多少钱。长任务里，用户最怕的是「不知道它是不是卡住了」。
- **取消是协作式的**：在两步之间检查取消标记；正在进行的 LLM 调用可以直接中断；已经执行的副作用，必要时要补偿。

## human-in-the-loop

### 三种介入点

1. **审批门**：执行有副作用的工具之前，先停下来问人。最常见。
2. **澄清问题**：agent 发现需求不明确，主动提问，等用户回答后再继续。
3. **结果审核**：最终产出（发出去的邮件、合并的代码、发布的文章）先由人看过再生效。

### 按风险给工具分级

| 级别 | 例子 | 策略 |
|---|---|---|
| 只读 | 搜索文档、读文件 | 自动执行 |
| 可逆的写操作 | 新建一篇草稿（DocPilot 的 `create_page`） | 自动执行或事后确认，可以撤销 |
| 不可逆或对外的操作 | 删除数据、发送邮件、付款、发布 | **必须事前批准** |

很多 agent 产品的权限模式就是这么设计的：读和搜随意，写入要确认，对外发送和删除每次都要明确授权（见 [Agent 权限与沙箱](/stack/sec-sandbox)）。

### 实现一个审批门

1. 模型请求调用一个需要审批的工具。循环**不执行它**，而是产生一个 `approval_required` 事件，内容是具体的动作：工具名和完整的参数，持久化存储，run 进入 `waiting_for_input` 状态。
2. 等待期间**不占资源**：durable 引擎的 signal 或定时器，不需要一个 worker 一直挂着，也不需要和模型保持连接。
3. 人做出决定：
   - **批准** → 执行**被批准的那组参数**，结果回传给模型，继续循环；
   - **拒绝** → 把「用户拒绝了这个操作，原因是……」作为一个 `is_error` 的工具结果回传给模型，让它调整方案，而不是直接终止整个任务；
   - **超时** → 执行预先定义好的安全默认动作（通常是视为拒绝），并通知相关的人。
4. 全程记录：谁、在什么时间、批准了什么具体的动作。

==批准必须绑定到具体的参数==：给人看的是「删除这 30 个文档」，执行的也必须正好是这 30 个。如果批准之后模型又改了参数再执行，审批就形同虚设。可以把待批准动作的参数哈希存下来，执行前比对。

### 别让审批变成橡皮图章

每个操作都要审批，用户很快就会不看内容直接点「同意」。所以要按风险分级，只拦真正危险的操作；审批界面要把**会发生什么**说清楚（展示 diff、影响范围），而不是只给一个「是否继续」的按钮。

## 失败处理

- **供应商故障**：LLM 调用作为可重试的步骤，按退避重试；持续失败时切换到备用模型（见 [LLM 网关](/stack/gw-routing)），或者让 run 暂停，等稍后再恢复。
- **工具故障**：错误回传给模型，让它换一种办法；连续失败超过阈值就让 run 失败，并保留现场。
- **凭证**：跑几个小时的 agent 不应该持有长期有效的高权限凭证。按需申请短期的、权限最小的 token，提升权限要经过审批。

## DocPilot 如果要支持长任务

假设要加一个「基于整个文档库生成报告」的功能：

1. 新增 `runs` 和 `run_events` 两张表，`POST /reports` 返回 202 和 run_id；
2. 循环放进 worker，每一步之后把消息和 trace 写进数据库，或者直接用 durable execution 引擎；
3. 前端订阅 `/runs/{id}/events`，刷新页面后能接着看；
4. 这个任务步数多，要配合上下文压缩（见[上下文压缩](/ai/context-compaction)）；
5. `create_page` 保存最终报告之前加一个确认步骤，让用户先预览。

## 追问

::: details 为什么跑几十分钟的 agent 不能放在一次 HTTP 请求里？
连接会断（代理超时、用户关页面、切换网络）；进程会重启（部署、扩缩容、崩溃），内存里的状态和已经花掉的成本全部丢失；用户不想一直等着；需要人工审批时不能一直占着 worker 和模型连接。正确的做法是把执行放进持久化的运行时，HTTP 只用来创建任务、查询状态和订阅事件。
:::

::: details 一个长时间运行的 agent 服务，API 应该怎么设计？
`POST /runs` 返回 202 和 run_id；`GET /runs/{id}` 返回状态、进度和成本；`GET /runs/{id}/events` 用 SSE 推送事件，支持 `Last-Event-ID` 断线续传；`POST /runs/{id}/approvals` 用来批准或拒绝待审批的动作；`POST /runs/{id}/cancel` 用来取消。状态包括 queued、running、waiting_for_input、succeeded、failed、cancelled。
:::

::: details agent 运行到一半崩溃了，怎么恢复而不重复执行副作用？
每一步之后做检查点：持久化消息历史、工具调用及结果、LLM 的输出。恢复时从最后一个检查点继续，已经完成的步骤直接用记录的结果。有副作用的工具用 `(run_id, tool_call_id)` 作为幂等 key，执行前检查是否已经做过。用 durable execution 引擎的话，这些由引擎负责：已完成的 activity 在重放时直接返回记录的结果。
:::

::: details 怎么实现「执行危险操作之前先让人批准」？
模型请求调用需要审批的工具时，循环不执行，而是产生一个包含工具名和完整参数的审批事件并持久化，run 进入等待状态，不占用 worker。批准后执行被批准的那组参数（用参数哈希比对，防止被篡改），结果回传给模型继续；拒绝时把拒绝原因作为错误的工具结果回传，让模型调整方案；超时就执行安全的默认动作（通常视为拒绝）。全程记录审计日志。
:::

::: details 用户拒绝了 agent 提出的操作，应该直接终止任务吗？
通常不应该。把「用户拒绝了，原因是……」作为一个 `is_error` 的工具结果回传给模型，它可以换一种方案（比如只删除其中 5 个，或者先导出备份）或者向用户澄清需求。只有在用户明确要求停止，或者没有其他可行方案时，才终止任务。
:::

::: details 怎么避免审批变成用户不看就点同意的橡皮图章？
按风险给工具分级：只读操作自动执行，可逆的写操作自动执行或事后确认，只有不可逆或对外的操作才要求事前批准。审批界面要说清楚具体会发生什么：展示 diff、影响范围、能不能撤销。审批太频繁，用户就会习惯性地放行。
:::

## 参考

- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)（human-in-the-loop 与检查点）
- [Temporal: Signals（等待外部输入）](https://docs.temporal.io/sending-messages#sending-signals)
- [LangGraph: Human-in-the-loop（interrupt / resume）](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/)
- [OpenAI Agents SDK: Human in the loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- 实战代码：DocPilot `api/src/docpilot/agent/loop.py`、`agent/tools.py`（`create_page`）、`routes/chat.py`
