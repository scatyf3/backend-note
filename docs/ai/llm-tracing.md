---
title: LLM tracing：每个回答是怎么来的、花了多少
status: draft
tags: [tracing, llm-observability, cost, opentelemetry, debugging]
difficulty: 3
order: 16
related: [/backend/observability, /ai/agent-loop, /ai/offline-evals, /ai/online-evals-ab, /ai/llm-latency-cost, /ai/llm-gateway]
stack: [ev-tracing]
---

# {{ $frontmatter.title }}

## 一句话结论

LLM trace 记录的是 ==「这个回答是怎么来的，花了多少」==：

- 这一轮用了哪个模型、哪一版 prompt；
- 每一步模型调用的 token、延迟和停止原因；
- 每次工具调用的参数、结果摘要、耗时和是否出错；
- 检索到了哪些内容；
- 最终的输出和引用，以及成本。

它是排查错误回答、按功能和用户归因成本、从线上采集 eval 数据、事后审计「模型当时看到了什么」的基础。它和分布式追踪是互补的：分布式追踪回答「慢在哪个服务」，LLM trace 回答「为什么是这个答案」。

## 为什么普通的日志和指标不够

一个用户反馈「回答错了」。要回答「为什么」，需要知道：

- 模型当时看到的上下文里有没有正确的信息（检索到了什么）？
- 它调用了哪些工具，用的什么参数，有没有工具出错？
- 它走了几步，在哪一步做出了错误的判断？
- 用的是哪个模型、哪一版 prompt？

这些信息分散在一次请求的多个步骤里，而且都和**这一个回答**绑定。指标只有聚合后的数字；普通日志是一行行零散的事件，很难拼出完整的过程。LLM trace 就是把这一轮的完整过程，作为一条结构化的记录存下来。

## 实战：DocPilot 的 trace

### 存什么

`traces` 表，每一轮 assistant 回答一行：

| 字段 | 内容 |
|---|---|
| `message_id` | 关联到这条回答（唯一，级联删除） |
| `retrieved_chunk_ids` | 模型看过的所有 chunk id，按首次出现的顺序去重 |
| `tool_calls` | JSON 数组，每次调用记录名称、参数、一行摘要、是否出错、耗时 |
| `model` | 实际使用的模型 |
| `input_tokens` / `output_tokens` | 这一轮所有步骤累计的 token |
| `latency_ms` | 这一轮的总耗时 |
| `cost_usd` | 按价格表算出的成本（`numeric(12,6)`） |

### 怎么用

- **流式输出时随回答一起返回**：流的末尾发一个 `data-trace` 事件，界面上每条回答下面有一个可展开的 Trace 面板，显示工具调用次数、chunk 数、token、耗时和成本。
- **按需加载详情**：展开时调用 `GET /traces/{message_id}`，服务端用 `retrieved_chunk_ids` 去数据库查出 chunk 的原文一起返回。
- **和回答原子写入**：trace 和这一轮的问题、回答在同一个事务里提交（见[索引、事务与隔离级别](/backend/sql-index-transaction)）。

### 只存 id，不存原文

trace 里存的是 chunk 的 **id**，而不是原文，查看时再去关联查询。好处是：

- **不重复存储**：同一个 chunk 被检索一百次，原文也只存一份；
- **尊重删除**：用户删除了文档，chunk 被级联删除，trace 里的 id 关联不到原文，自然也就不会再显示（`get_chunks` 会跳过查不到的 id）。对隐私和数据删除请求来说，这比在 trace 里复制一份原文要干净得多。

代价是：文档被删除或者重新入库之后，就没法完整还原「当时模型看到的到底是什么」了。需要严格审计的场景，要在保留期内存一份快照。

### 还缺什么

对照「排查一个错误回答需要什么」，DocPilot 的 trace 还缺几样东西：

1. **每一步模型调用的明细**：现在只有整轮的累计 token 和总耗时。一轮跑了 4 步，哪一步最慢、最贵，看不出来。
2. **TTFT**：用户感受最直接的延迟没有记录。
3. **prompt 版本**：只记了模型，没记 prompt 版本，prompt 改过几次后就分不清问题属于哪一版（见 [Prompt 设计与版本管理](/ai/prompt-versioning)）。
4. **结束原因**：`finish_reason`（正常结束、截断、拒答、步数用完）只在流里发给了前端，没有存进 trace，没法统计「有多少回答因为步数用完而被截断」。
5. **失败的轮次**：出异常走的是 `encoder.fail()` 路径，不会调用 `save_turn`，所以**出错的回答恰恰没有 trace**；客户端断开时也一样（见[并发模型](/backend/concurrency-models)）。最需要排查的情况反而没有记录。
6. **缓存命中的 token**：用上 prompt caching 之后，成本计算需要区分缓存读取和普通输入。

## 一条 LLM trace 应该长什么样

用 span 的方式组织（和分布式追踪一样）：

```
trace: chat turn (conversation_id, message_id, user, prompt_version)
├─ span: llm.call  step=0  model, input/output/cached tokens, ttft, finish_reason
├─ span: tool.search_docs  args, result count, duration, error?
│   ├─ span: retrieval.vector  k, duration
│   ├─ span: retrieval.fts     k, duration
│   └─ span: rerank            n, duration
├─ span: llm.call  step=1  ...
└─ span: citations.resolve  cited ids, resolved ids
```

OpenTelemetry 已经有一套 GenAI 语义约定，规定了这类 span 的标准属性名（比如 `gen_ai.request.model`、`gen_ai.usage.input_tokens`），用它的话，各种观测后端都能理解这些字段。

## 网关的 trace 和应用的 trace

| | 网关层（LLMGateway） | 应用层（DocPilot） |
|---|---|---|
| 看得到什么 | 每一次模型调用：后端、模型、token、成本、TTFT、缓存、fallback | 一整轮回答：所有步骤、工具调用、检索结果、引用 |
| 看不到什么 | 工具调用、检索、这次调用属于哪个对话的哪一步 | 网关内部的 fallback、缓存命中 |
| 优点 | 不用改应用代码，所有应用统一 | 有完整的业务语境 |

两者要**用同一个 id 关联起来**：应用调用网关时，在请求头里带上 trace id（比如 W3C `traceparent` 或者 `x-request-id`），网关把它记进自己的日志和指标。这样，一次回答在应用 trace 里看到「第 2 步模型调用花了 40 秒」，就能到网关那边查到「因为主后端超时，fallback 到了 OpenAI」。DocPilot 目前调用网关时没有传这个 id。

## trace 的几种用途

1. **排查**：一个错误回答，逐步看检索到了什么、模型怎么决定、哪一步走偏了。
2. **成本归因**：按功能、用户、模型、prompt 版本汇总 token 和成本，找出最贵的部分（见[延迟与成本模型](/ai/llm-latency-cost)）。
3. **构建 eval 数据集**：从线上 trace 里采样，特别是被用户点踩的、出了错的、触发了步数上限的，人工标注后加进离线数据集（见[离线 eval](/ai/offline-evals)）。
4. **线上自动评估**：对采样的 trace 异步地跑规则检查和 judge（见[线上评估](/stack/ev-online)）。
5. **审计**：在有合规要求的场景下，回答「这个结论是基于哪些文档、哪个模型得出的」。

## 隐私和保留

trace 里有 prompt、用户的问题、工具参数，很可能包含个人信息和机密：

- **最小化**：能存 id 的不存原文，能存摘要的不存全文（DocPilot 的工具日志只存一行摘要）；
- **保留期**：完整内容设置较短的保留期，聚合的数字可以长期保留；
- **访问控制**：不是所有工程师都应该能看到用户的原始对话；
- **跟随删除**：用户删除数据时，相关的 trace 也要能被删除（见[数据隐私与 PII](/stack/sec-privacy)）。

## 追问

::: details LLM trace 应该记录哪些信息？
一轮回答的上下文（会话、用户、模型、prompt 版本）；每一步模型调用的 token（区分缓存）、TTFT、耗时、结束原因；每次工具调用的名称、参数、结果摘要、耗时、是否出错；检索到的内容 id；最终输出、引用及其校验结果；成本。失败的轮次和被中断的轮次也要记录，它们往往最需要排查。
:::

::: details LLM trace 和分布式追踪有什么区别？
分布式追踪关注请求在多个服务之间的调用链和耗时，回答「慢在哪个服务」；LLM trace 关注一个回答的生成过程：检索到了什么、调用了哪些工具、每一步的 token 和成本，回答「为什么是这个答案、花了多少钱」。两者可以用同一套 span 模型（OpenTelemetry 有 GenAI 语义约定），用同一个 trace id 关联。
:::

::: details DocPilot 的 trace 为什么只存 chunk id，不存原文？有什么代价？
好处：不重复存储，同一个 chunk 被检索多少次原文都只有一份；文档删除后 chunk 级联删除，trace 自然不再显示原文，对隐私和数据删除更友好。代价：文档删除或重新入库后，无法完整还原当时模型看到的内容。需要严格审计时，要在保留期内存一份快照。
:::

::: details 对照排查需求，DocPilot 的 trace 还缺什么？
1. 每一步模型调用的明细（现在只有整轮累计）；
2. TTFT；
3. prompt 版本；
4. 结束原因（截断、拒答、步数用完）；
5. 出错和客户端断开的轮次根本没有 trace，因为它们不会走到 `save_turn`；
6. 缓存命中的 token。
:::

::: details 网关层的 trace 和应用层的 trace 各能看到什么？怎么关联？
网关能看到每一次模型调用的后端、模型、token、成本、TTFT、缓存命中和 fallback，但不知道这次调用属于哪个对话的哪一步，也看不到工具和检索。应用能看到完整的回答过程，但看不到网关内部发生的 fallback 和缓存命中。关联方法：应用调用网关时在请求头里带上 trace id（`traceparent` 或 `x-request-id`），网关记进自己的日志和指标。
:::

::: details 怎么利用线上 trace 改进系统？
从 trace 里采样被点踩的、出错的、触发步数上限的、引用校验失败的回答，人工标注后加入离线 eval 数据集；按功能、用户、模型汇总成本，找出最贵的环节；对采样的 trace 异步运行规则检查和 judge，作为线上质量指标；排查单个问题时逐步回看检索、工具调用和模型的决策。
:::

## 参考

- [OpenTelemetry: Semantic conventions for generative AI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Langfuse: Tracing](https://langfuse.com/docs/tracing)、[Arize Phoenix](https://docs.arize.com/phoenix)、[OpenLLMetry](https://github.com/traceloop/openllmetry)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- 实战代码：DocPilot `schema.sql`（`traces` 表）、`agent/loop.py`（`Done.trace`）、`store.py`（`save_turn`、`get_trace`）、`routes/chat.py`（`/traces/{message_id}`）、`web/src/components/TracePanel.tsx`；LLMGateway `gateway/metrics.py` 与 README 里的响应头说明
