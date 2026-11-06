---
title: Agent 循环：停止条件、上限与工具执行
status: draft
tags: [agent, agent-loop, tool-calling, workflow]
difficulty: 3
order: 12
related: [/ai/tool-calling-mcp, /ai/provider-api-structured-output, /backend/durable-execution, /backend/concurrency-models, /backend/streaming-sse-websocket, /ai/context-compaction, /ai/long-running-agents]
stack: [ag-loop]
---

# {{ $frontmatter.title }}

## 一句话结论

agent 循环的核心就是一个 while 循环：==调用模型 → 如果模型要求调用工具，就执行工具并把结果回传 → 再调用模型，直到模型给出最终答案或者触发停止条件==。逻辑本身只有十几行，工程上的难点全在**边界**：

- 根据 `stop_reason` 决定下一步做什么；
- 步数、时间、成本的上限；
- 工具怎么执行（并发、错误回传、超时）；
- 怎么把每一步流式推给用户；
- 每一步都要记进 trace。

另一个更重要的判断是：**什么时候真的需要 agent，什么时候一个固定的 workflow 就够了**。

## 为什么是一个循环

一次模型调用只能做一个决定。需要「先搜索、看结果、再决定下一步」的任务，只能一轮轮地调用：每一轮，模型根据目前为止的全部上下文，决定是继续调用工具，还是直接回答。循环把「决定」交给模型，把「执行」和「约束」留给代码。

## DocPilot 的循环（`agent/loop.py`）

```python
for step in range(max_steps):
    yield StepStart(step)
    async for event in provider.stream_turn(SYSTEM_PROMPT, messages, toolbox.specs):
        if isinstance(event, TextDelta): yield event      # 文本边生成边推给前端
        else: turn = event                                  # 一轮结束的汇总
    累计 input / output token
    if turn.stop_reason == "refusal":    补一句说明；finish_reason = "content-filter"；break
    if turn.stop_reason == "max_tokens": finish_reason = "length"；break      # 不执行被截断的 tool call
    if not turn.tool_calls:              break                                # 最终答案
    if step == max_steps - 1:            finish_reason = "other"；break       # 还想调工具，但步数用完了
    outcomes = await asyncio.gather(*(toolbox.run(c) for c in turn.tool_calls))   # 并发执行工具
    记录工具日志和看过的 chunk id
    provider.add_tool_results(messages, [o.result for o in outcomes])
yield Done(answer, finish_reason, trace)
```

几个值得注意的设计：

### 1. 先看 stop_reason，再执行工具

代码注释写的是「在执行模型要求的任何操作之前，先检查它为什么停下来」：

- **`max_tokens`**：输出在中途被截断，最后一个 tool call 的参数可能只写了一半。执行一个参数不完整的工具调用很危险，比如 `create_page` 拿到半截的 markdown。所以直接结束这一轮，`finish_reason` 记为 `length`。
- **`refusal`**：模型拒绝回答，补一句说明返回给用户，标记为 `content-filter`。
- **没有 tool call**：就是最终答案，正常结束。

==stop_reason 决定了这一轮的输出能不能被信任==，这一步不能省。

### 2. 步数上限，以及上限的语义

`max_agent_steps = 6`。到最后一步模型还想调用工具时，循环停止，`finish_reason` 记为 `other`，而不是假装正常结束。上限防的是：

- **死循环**：模型反复用同样的参数搜索；
- **成本失控**：每一步都要重发全部历史，输入 token 随步数近似平方增长（见 [Token 与上下文窗口](/ai/tokens-context-window)）；
- **延迟失控**：用户在等。

DocPilot 只限制了步数。生产环境通常还要加上：**总时长上限**（deadline）、**token / 成本预算**、**单个工具的超时**（DocPilot 的 Cohere rerank 设了 30 秒的 HTTP 超时，数据库查询没有设置超时）。

### 3. 同一轮的工具并发执行，错误不中断

模型一次可能要求调用多个工具（比如对一个多部分的问题搜索三次），`asyncio.gather` 并发执行它们，延迟取决于最慢的那个。`Toolbox.run` 把所有异常都转成 `is_error=True` 的结果，所以一个工具失败不会让整个回合崩溃，模型能看到哪个失败了，自己决定怎么处理（见[并发模型](/backend/concurrency-models)、[Tool calling 与 MCP](/ai/tool-calling-mcp)）。

要注意：**有副作用的工具并发执行可能互相冲突**，比如两个工具都去修改同一个文件。这类工具要么不允许并行（OpenAI 的 `parallel_tool_calls: false`，Anthropic 的 `disable_parallel_tool_use`），要么自己保证可以安全并发。

### 4. 循环与 provider、HTTP 都解耦

循环只依赖 provider 中立的接口（见 [Provider API](/ai/provider-api-structured-output)），对外产出一串事件：`StepStart`、`TextDelta`、`ToolStarted`、`ToolFinished`、`Done`。路由层把这些事件编码成前端能消费的 SSE 流（见[流式接口](/backend/streaming-sse-websocket)），eval 也通过同一个接口重放。循环里没有任何 HTTP 和数据库的代码，所以用假的 provider 和 toolbox 就能写单元测试。

### 5. 每一步都留痕

`Done` 带着完整的 trace：模型、按顺序去重的「看过的 chunk id」、每次工具调用（名称、参数、摘要、是否出错、耗时）、累计 token、总延迟、成本。线上一个回答有问题时，可以准确地看到它搜了什么、读了什么、在哪一步走偏了（见 [LLM tracing](/stack/ev-tracing)）。

一个小细节：最终答案是**每一步的文字拼起来**的（`"\n\n".join(step_texts)`），模型在调用工具之前说的「我先搜一下」也会成为答案的一部分，被存进历史。要不要保留这些中间的叙述，是一个产品上的选择。

## 循环常见的失败模式

| 现象 | 原因 | 对策 |
|---|---|---|
| 反复用同样的参数调同一个工具 | 模型没意识到结果不会变 | 步数上限；检测连续重复的调用，在结果里提示模型 |
| 不调工具直接回答（编造） | prompt 没有强调必须先检索 | system prompt 明确要求；eval 里检查有没有检索 |
| 调用不存在的工具或参数错误 | schema 或 description 写得不清楚 | 把具体的错误回传给模型；改进工具定义 |
| 一步失败导致后面全错 | 工具错误被当成了正常结果 | `is_error` 标记清楚，让模型知道这一步失败了 |
| 跑了很久才停 | 没有时间和成本上限 | deadline 和预算一起限制 |

## 什么时候用 agent，什么时候用 workflow

Anthropic 的 *Building effective agents* 区分了两类系统：

- **workflow**：LLM 和工具按**代码预先定义好的路径**编排。常见的模式有：prompt chaining（一步接一步）、routing（先分类再分流）、parallelization（并行处理再汇总）、orchestrator-workers（一个 LLM 拆解任务、分给多个 worker）、evaluator-optimizer（生成、评审、改进的循环）。
- **agent**：LLM **自己决定**步骤和工具调用的顺序。

==先用最简单的方案==：能用一次调用加检索解决的，就不要上 agent；步骤固定的，用 workflow；只有步骤数和路径事先无法确定的任务（多跳检索、开放式调研、编码），才值得用 agent。agent 的代价是延迟更高、成本更高、行为更难预测和测试。

DocPilot 选择 agentic RAG，是因为它的问题里有相当比例的多跳问题（eval 里 110 题中有 37 题需要多个文档），固定的「检索一次再回答」处理不了；同时用 6 步的上限和明确的 system prompt 把 agent 的不确定性控制在小范围内。

## 多 agent

一个 orchestrator agent 把任务拆开，分发给多个子 agent，各自在自己的上下文里工作，再汇总结果。好处是并行和上下文隔离（见[上下文压缩](/ai/context-compaction)）；代价是 token 成本成倍增加，信息在交接时会丢失，调试也更难。只有在任务确实能拆成相互独立的子任务时才划算。

## 追问

::: details 写出一个最小的 agent 循环，并说明它需要处理哪些停止条件。
```
for step in range(MAX_STEPS):
    resp = model(messages, tools)
    messages.append(resp)
    if resp.stop_reason == "max_tokens": stop("length")      # 不执行被截断的 tool call
    if resp.stop_reason == "refusal":    stop("refused")
    if not resp.tool_calls:              return resp.text    # 最终答案
    results = run_all(resp.tool_calls)                       # 并发执行，错误转成 is_error 结果
    messages.append(tool_results(results))
stop("step budget exhausted")
```
停止条件：正常结束（没有 tool call）、输出被截断、拒答、步数用完；生产环境还要加总时长和成本预算。
:::

::: details 为什么要在执行工具之前先检查 stop_reason？
`max_tokens` 说明输出在中途被截断了，最后一个 tool call 的参数可能不完整，执行它可能造成错误甚至危险的副作用（比如写入半截的内容）。`refusal` 说明模型拒绝了，不应该继续。DocPilot 的循环在这两种情况下都直接结束这一轮，并标记对应的 finish_reason，不执行任何工具。
:::

::: details agent 循环应该设置哪些上限？只限制步数够吗？
步数上限防死循环，但不够。还需要：总时长的 deadline（用户在等）、token / 成本预算（每一步都重发全部历史，成本随步数近似平方增长）、单个工具调用的超时（一个卡住的工具会卡住整个回合）。触发上限时要如实标记结束原因（DocPilot 用 `finish_reason = "other"`），而不是假装正常完成。
:::

::: details 模型一次要求调用多个工具，应该串行还是并发执行？要注意什么？
只读、互不依赖的工具应该并发执行（DocPilot 用 `asyncio.gather`），延迟取决于最慢的那个。要注意：
1. 一个工具失败不能让其他工具的结果丢失，在每个工具内部捕获异常并转成错误结果；
2. 返回结果时要和 tool call 的 id 一一对应；
3. 有副作用、可能互相冲突的工具，要禁止并行调用，或者自己保证可以安全并发。
:::

::: details 怎么防止 agent 陷入死循环？
步数上限是兜底。另外可以检测连续的、参数完全相同的工具调用，在工具结果里提示「你已经用同样的参数调用过了，结果不会变」；加上时长和成本预算；改进工具的 description 和错误信息，让模型知道什么时候该停止。trace 里要记录每一步的调用，方便发现这种模式。
:::

::: details 什么时候应该用 agent，什么时候用固定的 workflow？
先用最简单的：一次调用加检索能解决的，就不要用 agent；步骤固定的，用 workflow（prompt chaining、routing、parallelization 等），可预测、便宜、容易测试。只有步骤数和路径事先无法确定的任务（多跳检索、开放式调研、编码）才用 agent，并且要用步数上限、明确的 prompt 和 eval 控制它的不确定性。DocPilot 用 agentic RAG，是因为它的问题里有约三分之一是多跳的。
:::

::: details 线上一个 agent 给出了错误的答案，你会怎么排查？
看这一轮的 trace：每一步模型输出了什么、调用了哪些工具、参数是什么、工具返回了什么、有没有出错，以及最终引用了哪些内容。判断错误出在哪一层：检索没找到（工具结果里没有正确信息）、找到了但模型没用上或者理解错了、工具出错被忽略了，还是 prompt 没有约束住。修复之后，把这个案例加进 eval 数据集。
:::

## 参考

- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Yao et al., [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
- [Anthropic: Tool use（`stop_reason`、并行工具调用）](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)
- 实战代码：DocPilot `api/src/docpilot/agent/loop.py`、`agent/tools.py`、`chat_stream.py`、`config.py`（`max_agent_steps`）
