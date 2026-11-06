---
title: 同步 / 异步交互模式：用户等多久，任务跑多久
status: draft
tags: [interaction, streaming, async, batch, ux, agent]
difficulty: 3
order: 21
related: [/backend/streaming-sse-websocket, /backend/background-jobs, /ai/long-running-agents, /ai/model-tiering-batch, /ai/llm-latency-cost, /backend/capacity-estimation]
stack: [ai-interaction]
---

# {{ $frontmatter.title }}

## 一句话结论

AI 功能用哪种交互模式，取决于两个时间：==**用户愿意等多久**，和**任务实际要跑多久**==。

- **一秒以内**：同步请求；
- **几秒到一分钟**：流式输出；
- **几分钟**：异步任务（返回 202，之后轮询或推送结果）；
- **几小时**：后台 agent（有 id 的 run、通知、审批）；
- **不急**：离线批处理（batch 接口，五折）。

选错交互模式，比选错模型更伤体验，也更浪费钱。每一种模式对应一套不同的基础设施：流式需要长连接和正确配置的代理，异步需要任务队列和状态存储，后台 agent 需要 durable execution 和通知渠道。

## 为什么交互模式是架构决策

LLM 调用比普通接口慢三到四个数量级（见[容量估算](/backend/capacity-estimation)）。同样一个「生成摘要」的功能：

- 做成同步接口，用户要对着转圈等 20 秒，网关和代理的超时还可能先把请求掐断；
- 做成流式，用户一秒后就开始读；
- 做成异步任务，用户可以关掉页面，完成后收到通知；
- 如果是给 1 万篇文档批量生成摘要，走 batch 接口，成本减半。

模式一旦选定，就决定了要用哪些基础设施、怎么处理失败、怎么计费、怎么测试。事后再改，往往要重写接口和前端。

## 五种模式

| 模式 | 任务时长 | 典型场景 | 基础设施 | 失败处理 |
|---|---|---|---|---|
| **同步** | < 1–2 s | 分类、抽取、短文本改写、校验 | 普通 HTTP，严格的超时 | 直接重试（操作幂等的话） |
| **流式** | 几秒到一分钟 | 聊天、问答、写作助手 | SSE、关闭代理缓冲、心跳 | 200 已经发出，只能在流里报错 |
| **异步任务** | 几分钟 | 文档入库、生成报告、长文翻译 | 任务队列、状态表、通知 | 后台自动重试，状态可查询 |
| **后台 agent** | 几分钟到几小时 | 调研、编码、需要审批的多步操作 | durable execution、事件流、审批 | 检查点、断点恢复 |
| **批处理** | 不急（最长 24 小时） | eval、批量打标、回填 embedding | batch 接口、离线任务 | 逐条记录结果，失败的再提交 |

还有一种**主动触发**的模式：不是用户发起，而是由事件或定时任务触发。比如新文档上传后自动生成摘要，每天早上自动整理昨天的工单。本质上是异步任务或批处理，只是触发方式不同。

### 程序调用还是人在看

另一个决定要不要流式的因素是**谁在消费结果**：

- **人在看**：用流式，首字延迟（TTFT）就是体验；
- **程序在消费**（结构化抽取、分类、工具调用的结果）：用非流式更简单，拿到完整的 JSON 再一次性校验。流式只会增加解析碎片的复杂度（见 [Provider API 与结构化输出](/ai/provider-api-structured-output)）。

LLMGateway 两种都支持，缓存还可以在两者之间共享：exact cache 的 key 不包含 `stream` 字段，流式请求命中缓存时，会把存下来的完整响应回放成 SSE。

## 体验上要做的事

### 让等待可见

- **流式文字**：最基本的。
- **显示中间步骤**：agent 搜索、读文档、调用工具时，把这些步骤也推给前端。DocPilot 的流里除了文字，还有 `tool-input-available`、`tool-output-available` 事件，前端能显示「正在搜索……」「读了哪几篇文档」，用户知道它没卡住（见[流式接口](/backend/streaming-sse-websocket)）。
- **异步任务显示进度**：处理到第几步、预计还要多久。
- **完成后通知**：站内通知、邮件、webhook。

### 让用户能控制

- **能取消**：取消之后要真的停止生成，不再继续花钱（见[并发模型](/backend/concurrency-models)里的取消）；
- **能拿到部分结果**：长任务被中断或者超出预算时，返回已经完成的部分；
- **能离开再回来**：刷新页面之后能接着看，需要把生成和连接解耦（见[长任务与 human-in-the-loop](/stack/ag-durable)）。

### 混合模式

聊天里最自然的体验往往是混合的：先流式地回答「好的，我来整理这份报告，大概需要 10 分钟，完成后通知你」，然后把真正耗时的工作交给后台 agent，用户可以继续聊别的。

## 实战：两个仓库里的模式

| 功能 | 当前模式 | 评价 |
|---|---|---|
| DocPilot 聊天 | 流式，带工具步骤事件 | 合适，最多 6 步、几十秒结束 |
| DocPilot 文档上传 | **同步**：在请求里解析、切分、embedding、写库 | 大文件会超时，还会阻塞事件循环，应该改成异步任务（见[后台任务](/backend/background-jobs)） |
| DocPilot eval | 离线运行，并发调用 judge | 天然适合批处理：judge 调用不需要实时返回，改用 batch 接口可以省一半费用（见[模型分级与 batch](/stack/ai-cost)） |
| 「全库生成报告」（假设的新功能） | 还没有 | 应该做成后台 agent：有 id 的 run、可续传的事件流、保存之前确认 |

==同一个产品里通常同时存在好几种模式==，每个功能要按它自己的时长和消费者来选。

## 切换模式要付出什么

把一个同步接口改成异步，影响的不只是后端：

- **接口契约变了**：从「直接返回结果」变成「返回任务 id，之后查询」，所有调用方都要改；
- **前端要加状态**：排队中、处理中、完成、失败；
- **失败处理变了**：同步时用户看到错误就重试；异步时要后台自动重试，失败要能通知到人；
- **测试变了**：要测状态流转和最终一致。

所以设计接口时就要预估任务时长的上限，而不是先做成同步、等超时了再改。

## 追问

::: details 怎么为一个 AI 功能选择交互模式？
看两个时间和一个对象：用户愿意等多久、任务实际要跑多久、谁在消费结果。一秒内用同步；几秒到一分钟、有人在看的用流式；几分钟的用异步任务；几小时、可能需要审批的用后台 agent；不急的用批处理。程序消费结构化结果时，用非流式更简单。
:::

::: details 什么时候用流式，什么时候用非流式？
有人在等着看结果时用流式，用户感知的延迟从完整的生成时间降到首 token 时间。结果由程序消费时（结构化抽取、分类、工具调用）用非流式更简单，拿到完整的输出再整体校验，不用处理碎片。LLMGateway 两种都支持，而且流式和非流式请求共享同一份缓存。
:::

::: details 为什么说 DocPilot 的文档上传应该改成异步任务？
现在上传请求里同步完成解析、切分、embedding 和写库：大文件可能超过网关和代理的超时；CPU 密集的解析会阻塞事件循环，拖慢同一个进程上所有的流式聊天；embedding 接口失败时，用户只能重新上传。改成异步：返回 202 和文档 id，worker 在后台处理并重试，前端轮询或订阅状态。
:::

::: details agent 运行时，怎么让用户知道它没卡住？
把中间步骤也推给前端：开始搜索、搜到了什么、读了哪篇文档、调用了哪个工具。DocPilot 的流里除了文字，还有工具调用的输入和输出事件。异步任务显示进度和预计时间，完成后通知。再加上能取消、能拿到部分结果、刷新后能接着看。
:::

::: details 什么样的任务适合用 batch 接口？
不需要实时结果、量大、可以等到最长 24 小时的任务：离线 eval（比如 DocPilot 每次运行要调用 110 次 judge）、批量打标或分类、换模型后回填 embedding、每晚的摘要和报告。主流供应商的 batch 接口给五折。代价是延迟不可控，要逐条处理结果，失败的再提交。
:::

::: details 把一个同步的 AI 接口改成异步，要改哪些东西？
接口契约（直接返回结果改成返回任务 id，所有调用方都要改）；前端要处理排队、处理中、完成、失败几种状态；失败处理改成后台自动重试并通知；需要任务队列和状态存储；测试要覆盖状态流转。所以设计时就要预估任务时长的上限，一开始就选对模式。
:::

## 参考

- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Anthropic: Message Batches](https://docs.anthropic.com/en/docs/build-with-claude/batch-processing)、[OpenAI: Batch API](https://platform.openai.com/docs/guides/batch)
- [Vercel AI SDK: Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
- Jakob Nielsen, [Response Times: The 3 Important Limits](https://www.nngroup.com/articles/response-times-3-important-limits/)（0.1 秒、1 秒、10 秒）
- 实战代码：DocPilot `ui_stream.py`、`chat_stream.py`、`routes/documents.py`、`evals/run.py`；LLMGateway `gateway/cache/exact.py`、`gateway/pipeline.py`
