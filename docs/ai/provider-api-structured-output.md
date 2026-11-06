---
title: Provider API 与结构化输出
status: draft
tags: [llm-api, openai, anthropic, structured-output, streaming]
difficulty: 3
order: 4
related: [/ai/tool-calling-mcp, /ai/sampling-nondeterminism, /backend/api-design, /backend/streaming-sse-websocket, /ai/llm-gateway]
stack: [gw-api]
---

# {{ $frontmatter.title }}

## 一句话结论

各家 LLM API 的骨架都一样：==消息列表进去，出来的是内容块、stop_reason 和 usage==。但细节处处不同：system prompt 放在哪、tool call 怎么表示、tool result 怎么回传、流式事件长什么样、stop_reason 叫什么名字。工程上有两种隔离差异的办法：

- 在应用里定义一个**与供应商无关的接口**，每家各写一个 adapter（DocPilot 的 `llm/base.py`）；
- 在网关把所有供应商**统一成 OpenAI 格式**（LLMGateway）。

结构化输出从弱到强有三级：在 prompt 里要求输出 JSON → JSON mode → **按 JSON Schema 做约束解码**。最后一级能保证**格式**合法，但不能保证**内容**正确，所以拿到结果后照样要校验。

## 为什么要关心格式差异

后端几乎不可能只用一家模型：要做 fallback、按成本路由、对比 eval，还可能接自托管的 vLLM。格式差异如果漏进业务代码，换模型就要改 agent 循环。而且这些差异很多是**语义上的**，不只是字段改个名。

## 两大格式对比

| | OpenAI Chat Completions | Anthropic Messages |
|---|---|---|
| system prompt | `messages` 里一条 `role: system`（或 `developer`） | 顶层的 `system` 字段 |
| 助手的输出 | `content` 字符串 + `tool_calls[]` | **内容块列表**：`text`、`tool_use`、`thinking`… |
| tool call 参数 | `function.arguments` 是一个 **JSON 字符串** | `tool_use.input` 是一个 **JSON 对象** |
| tool result | 每个结果一条 `role: tool` 消息，带 `tool_call_id` | 同一轮的所有结果放进**一条** user 消息，每个是一个 `tool_result` 块 |
| 停止原因 | `finish_reason`：`stop` / `tool_calls` / `length` / `content_filter` | `stop_reason`：`end_turn` / `tool_use` / `max_tokens` / `refusal` / `stop_sequence` |
| usage | `prompt_tokens` / `completion_tokens`；流式要带 `stream_options.include_usage` | `input_tokens` / `output_tokens`，另外单独列出 cache 读写的 token |
| temperature 范围 | 0–2 | 0–1，而且新模型不接受这个参数 |

几个会咬人的细节：

1. **参数是字符串还是对象**：OpenAI 的 `arguments` 是模型生成的一段字符串，**可能不是合法的 JSON**。DocPilot 的 `ToolCall.args` 允许为 `None`，同时保留 `raw_args`，解析失败就把「参数不是合法 JSON」作为工具错误回传给模型，而不是抛异常。
2. **thinking 块要原样回传**：Anthropic 的推理模型返回的 `thinking` 块带有签名，下一轮必须**一字不改**地放回历史里。`anthropic_provider.py` 文件开头写着：完整的 `response.content`（thinking + tool_use）原样追加到历史。所以「先转成一个通用格式，下一轮再转回来」这种做法是会丢信息的。
3. **tool result 的分组方式不同**：同一轮的三个工具结果，OpenAI 是三条消息，Anthropic 是一条消息里的三个块。DocPilot 的接口方法 `add_tool_results` 的注释里专门写了：「one message for Anthropic, N for OpenAI」。

## 实战 1：DocPilot 的 provider 接口

`llm/base.py` 定义了 agent 循环唯一能看到的接口：

```python
class LLMProvider(Protocol):
    model: str
    def start(self, history, user_text) -> list: ...          # 构造原生格式的消息
    def stream_turn(self, system, messages, tools)            # 流式输出一轮
        -> AsyncIterator[TextDelta | TurnResult]: ...
    def add_tool_results(self, messages, results) -> None: ...
```

关键的设计选择是：==每个 provider 用**自己的原生格式**保存对话，agent 循环从来不碰这个列表==。循环只拿到 provider 中立的 `TextDelta`（流式文本）和 `TurnResult`（文本、tool calls、停止原因、token 数）。好处是：

- thinking 签名这类只有某一家才有的内容，不会在格式转换中丢失；
- 新增一家供应商只需要写一个 adapter，循环不用动；
- `fake_provider.py` 实现了同一个接口，单元测试不需要 key，结果完全确定。

停止原因被归一成四种：`end`、`tool_use`、`max_tokens`、`refusal`。循环对每种的处理各不相同（见 [Agent 循环](/stack/ag-loop)）。

## 实战 2：网关的格式翻译

LLMGateway 的选择正好相反：对外只说 OpenAI 格式，所有后端都返回 OpenAI 格式的 dict，只有 `backends/anthropic_translate.py` 做双向翻译（全是纯函数，方便测试）：

- system / developer 消息 → 顶层 `system`；
- `assistant.tool_calls` → `tool_use` 块；连续的 `role: tool` 消息 → 一条装满 `tool_result` 的 user 消息；
- `response_format: json_schema` → Anthropic 的 `output_config.format`；
- `parallel_tool_calls: false` → `disable_parallel_tool_use`；
- usage：prompt token = input + cache 写入 + cache 读取，三者相加；
- **流式**：Anthropic 的内容块是对文本、thinking、tool_use 统一编号的，而 OpenAI 只给 tool call 编号。所以翻译器维护一张「块序号 → tool call 序号」的映射表，并**丢弃 thinking delta**。

有些差异翻译不过去，网关在 README 里明确列出了这些「故意留下的缺口」：

- `tool_choice` 只支持 `auto` 和 `none`：`required` 或指定某个函数，对应 Anthropic 的 `any` / `tool`，而当前的 Claude 5.5 模型会对它们返回 400，所以降级成 `auto` 并打一条告警日志。==需要「保证调用工具」的调用方，得在 prompt 里要求，并自己检查返回里有没有 tool call==。
- `claude-*-5*` 模型会丢掉 temperature / top_p；其他 Claude 模型的 temperature 会被截到 1.0（OpenAI 允许到 2）。
- 最后一条是 assistant 的 prefill 请求直接返回 400，并给出明确的错误信息。

==翻译层最重要的不是能翻什么，而是把翻不了的东西明确地暴露出来==：要么返回清楚的错误，要么降级并留下日志，不要静默地改变语义。

## 流式的差异：tool call 是一块一块到的

- **OpenAI**：每个 chunk 的 `delta.tool_calls[]` 里带一个 `index`；`id` 和 `name` 通常只在第一个碎片里出现，`arguments` 是字符串碎片，要**按 index 拼接**。DocPilot 的 `openai_provider.py` 用一个 `index → {id, name, arguments}` 的字典来累积。
- **Anthropic**：`content_block_start`（声明一个 `tool_use` 块）→ 多个 `input_json_delta` → `content_block_stop`；最终的 stop_reason 和 usage 在 `message_delta` 事件里。SDK 提供 `get_final_message()`，帮你把整条消息组装好。
- **兼容的服务器不一定守规矩**：`openai_provider.py` 里有一行防御性代码：如果收到了 tool call，但 finish_reason 报的是 `stop`，就把它当成 `tool_use`。注释写的是「some servers report 'stop' even when they emitted tool calls」。对接 vLLM、OpenRouter 这类「OpenAI 兼容」服务时，这种差异很常见。

## 结构化输出：三个级别

| 级别 | 做法 | 保证 |
|---|---|---|
| 1. prompt 约束 | 「请只输出 JSON，格式如下…」，然后解析，失败就重试 | 什么都不保证，可能夹带解释文字、可能截断 |
| 2. JSON mode | API 参数要求输出合法 JSON | 语法合法，**结构不保证** |
| 3. schema 约束解码 | 传入 JSON Schema（OpenAI `strict: true`，Anthropic `output_config.format`） | 语法合法，并且**符合 schema** |

### 约束解码的原理

每生成一个 token 之前，根据「到目前为止的输出 + schema」算出接下来哪些 token 是合法的，把不合法 token 的 logits 设成 $-\infty$，然后再采样。schema 会被编译成有限状态机或上下文无关文法（开源实现有 Outlines、XGrammar）。所以模型**在物理上**就无法输出不合法的结构。

代价和限制：

- **schema 有子集限制**：通常要求 `additionalProperties: false`、所有字段 required，对递归深度、某些关键字也有限制。
- **首次请求有编译开销**：新 schema 第一次使用时要编译文法，之后会被缓存。
- **截断和拒答仍然会破坏输出**：输出到一半碰到 `max_tokens`，或者模型拒答，返回的 JSON 依然是不完整的。DocPilot 的 judge（`evals/judge.py`）在解析之前先检查：`stop_reason` 是 `refusal` 或 `max_tokens` 就直接抛错，不去解析一段半截的 JSON。
- **内容不保证正确**：schema 只管形状。`correct: true` 这个字段是合法的布尔值，但判断本身可能是错的。语义校验（范围、业务规则）还要用 pydantic 之类的工具再做一遍。
- **字段顺序会影响质量**：生成是从左到右的，把「理由」字段放在「结论」字段之前，模型就能先推理再下结论。对于有 thinking 的模型，推理主要发生在 thinking 里，这一点就没那么关键了。

## 追问

::: details OpenAI 和 Anthropic 的 tool calling 格式有哪些关键区别？
1. 参数：OpenAI 的 `arguments` 是 JSON **字符串**（可能解析失败），Anthropic 的 `input` 是**对象**。
2. 结果回传：OpenAI 每个结果一条 `role: tool` 消息；Anthropic 同一轮的所有结果放进**一条** user 消息，每个是一个 `tool_result` 块。
3. system prompt：OpenAI 是一条消息，Anthropic 是顶层字段。
4. 停止原因的命名不同：`tool_calls` vs `tool_use`，`length` vs `max_tokens`，`content_filter` vs `refusal`。
5. Anthropic 的 thinking 块要原样放回历史。
:::

::: details 抽象多家 LLM 供应商时，为什么 DocPilot 让每家保存自己的原生消息格式，而不是转成一个通用格式？
转成通用格式再转回来是有损的：Anthropic 的 thinking 块带签名，必须原样放回下一轮请求；各家还有独有的字段和块类型。DocPilot 的做法是让 provider 用原生格式保存对话，只对外暴露中立的 `TextDelta` / `TurnResult` 和 `add_tool_results` 这几个操作，agent 循环从来不碰消息列表本身。代价是每家要写一个 adapter，但循环代码只有一份。
:::

::: details 流式响应里，tool call 是怎么拼出来的？
OpenAI：每个 chunk 带 `delta.tool_calls[{index, id?, function{name?, arguments?}}]`，按 `index` 把 `arguments` 字符串碎片拼起来，`id` 和 `name` 一般只在第一个碎片里出现；流结束后再解析 JSON。Anthropic：`content_block_start` 声明 `tool_use` 块，之后是一串 `input_json_delta`，最后 `content_block_stop`。网关在两者之间翻译时，要把 Anthropic 统一编号的块序号映射成 OpenAI 只给 tool call 编的序号，并丢弃 thinking delta。
:::

::: details JSON mode 和 structured outputs（schema 约束）有什么区别？约束解码是怎么实现的？
JSON mode 只保证输出是合法的 JSON，结构可以随意；structured outputs 保证输出符合给定的 JSON Schema。

实现：把 schema 编译成状态机或文法，每一步生成前算出合法的下一个 token 集合，把其他 token 的 logits 设为 $-\infty$ 再采样。限制：schema 有子集要求，首次编译有延迟，截断或拒答时仍然会得到不完整的输出，而且内容本身的正确性不保证。
:::

::: details 用了 structured outputs，为什么解析之前还要检查 stop_reason？
约束解码只管「每一步选合法的 token」，管不了「生成被中途打断」。碰到 `max_tokens`，输出就是半截 JSON；模型拒答（`refusal`）时，可能根本没有按 schema 输出。DocPilot 的 judge 在这两种情况下直接抛错，不去解析。
:::

::: details 网关把 OpenAI 请求翻译成 Anthropic 时，遇到翻译不了的参数该怎么办？
两种处理，原则是不要静默改变语义：
1. **能安全降级的就降级并留日志**：`tool_choice: required` 降级成 `auto` 并打告警，调用方需要的话自己在 prompt 里要求并检查结果；新模型不支持的 temperature 直接丢掉。
2. **会改变语义的就明确报错**：assistant prefill、`n > 1` 返回清楚的 400。

所有这些缺口都写进文档，让调用方知道哪里不对等。
:::

## 参考

- [OpenAI: Function calling](https://platform.openai.com/docs/guides/function-calling)、[OpenAI: Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
- [Anthropic: Tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)、[Anthropic: Streaming messages](https://docs.anthropic.com/en/docs/build-with-claude/streaming)
- Willard & Louf, [Efficient Guided Generation for Large Language Models](https://arxiv.org/abs/2307.09702)（Outlines 的有限状态机方法）
- Dong et al., [XGrammar: Flexible and Efficient Structured Generation Engine for LLMs](https://arxiv.org/abs/2411.15100)
- 实战代码：DocPilot `api/src/docpilot/llm/`（`base.py`、`openai_provider.py`、`anthropic_provider.py`、`fake_provider.py`）、`evals/judge.py`；LLMGateway `gateway/backends/anthropic_translate.py` 与 README「Anthropic translation」一节
