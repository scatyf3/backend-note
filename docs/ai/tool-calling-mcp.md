---
title: Tool calling 与 MCP
status: draft
tags: [tool-calling, function-calling, mcp, agent]
difficulty: 3
order: 5
related: [/ai/provider-api-structured-output, /ai/agent-loop, /ai/prompt-injection, /ai/agent-sandbox, /backend/api-design, /backend/idempotency]
stack: [ag-tools]
---

# {{ $frontmatter.title }}

## 一句话结论

tool calling 的本质是：==模型只输出一个结构化的**调用意图**（工具名 + JSON 参数），真正执行的是你的代码，执行结果再作为一条消息回传给模型==。模型从来不直接执行任何东西。所以工具定义（name、description、JSON Schema）就是一份**写给模型看的 API 文档**，它写得好不好，直接决定模型会不会调、调得对不对。工具出错时要把错误回传给模型，让它自己修正，而不是中断整个回合。

**MCP**（Model Context Protocol）把「工具由谁提供」这件事标准化了：一个 MCP server 暴露工具、资源和 prompt，任何支持 MCP 的宿主（Claude Desktop、IDE、自己写的 agent）都能接上。它和 function calling 是两层：function calling 是模型 API 的能力（模型怎么表达调用），MCP 是集成协议（应用怎么发现和调用外部提供的工具）。

## 为什么：模型只会生成文本

模型唯一能做的事是生成 token。要让它「查数据库」「搜文档」「写文件」，只能约定一种格式：模型生成一段结构化的文本表示「我想调用 X，参数是 Y」，应用解析后去执行，再把结果当成新的输入喂回去。一次完整的交互是：

```
请求：messages + tools[{name, description, input_schema}]
  ↓
模型：stop_reason = tool_use，返回 [tool_use{id, name, input}, ...]
  ↓
应用：校验参数 → 执行 → 把 tool_result{tool_use_id, content, is_error} 加进 messages
  ↓
再次请求模型 → ……直到 stop_reason = end_turn
```

这就是 [agent 循环](/stack/ag-loop)的最小形态。由此可以推出几件事：

- **模型可以一次请求多个工具**（parallel tool calls），应用可以并发执行它们。
- **执行权完全在应用手里**：要不要执行、用谁的权限执行、要不要先问用户，都由应用决定。安全边界也在这里（见 [Agent 权限与沙箱](/stack/sec-sandbox)）。
- **工具结果就是模型的输入**：结果里如果混进了恶意指令，模型可能会照做，这就是间接 prompt injection（见 [Prompt injection](/stack/sec-injection)）。

## 设计工具：DocPilot 的 `agent/tools.py`

DocPilot 只有三个工具：`search_docs`、`read_doc`、`create_page`。几个值得照抄的做法：

### 1. 一个 pydantic 模型同时生成 schema 和做校验

```python
class SearchDocsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, description="What to look for, in natural language.")
    top_k: int = Field(5, ge=1, le=10, description="How many chunks to return (default 5).")
```

`model_json_schema()` 生成给模型看的 JSON Schema，同一个类的 `model_validate()` 校验模型返回的参数。文件开头的注释说得很清楚：==schema 和校验不可能对不上==。`extra="forbid"` 让多余的字段立刻报错，`le=10` 防止模型一次要 1000 条结果、撑爆上下文。

### 2. description 写清楚「什么时候调用、什么时候不要调用」

- `search_docs`：「在回答任何关于文档的问题之前都要调用；多部分的问题要换个说法再搜，或者每个部分各搜一次。」
- `create_page`：「**只有**用户要求写、起草或保存页面时才调用。」

有副作用的工具尤其要写明「什么时候**不要**调用」。tool description 和 system prompt 一起构成模型对工具的全部认知。

### 3. 错误回传给模型，而不是抛异常

`Toolbox.run` 捕获所有异常，转成 `is_error=True` 的工具结果：

| 情况 | 回传给模型的内容 |
|---|---|
| 不存在的工具名 | `Error: unknown tool 'xxx'` |
| 参数不是合法的 JSON | `Error: arguments were not valid JSON: <前 200 个字符>` |
| 参数不符合 schema | `Error: invalid arguments: <pydantic 的错误详情>` |
| 执行时异常 | `Error: <异常类型>: <消息>` |
| 文档不存在 | `Error: no document with id 42` |

注释原话是：「a failing tool should not kill the turn; tell the model」。模型看到具体的错误后，通常会修正参数再调一次。==对模型来说，清楚的错误信息就是最好的修复指引。==

### 4. 一次执行，三种受众

`ToolOutcome` 把一次工具执行的结果拆成四个字段：

- `result`：回传给**模型**的文本，chunk 用 `<chunk id="…" doc_id="…" title="…">` 包起来，模型才能引用 id；
- `output`：显示在**界面**上的结构化数据（标题、分数、200 字的摘要）；
- `summary`：写进 **trace** 的一行描述；
- `chunk_ids`：记录模型看过哪些 chunk，用于之后的引用校验。

模型需要完整的内容，界面需要简洁的展示，trace 需要能检索的摘要，三者的需求不同，不要用同一份数据凑合。

### 5. 控制工具输出的大小

工具返回的内容会进入之后每一步的上下文（见 [Token 与上下文窗口](/ai/tokens-context-window)），所以要有上限：`top_k` 最多 10，`read_doc` 最多返回 40 个 chunk（`READ_DOC_MAX_CHUNKS`）。

### 6. 工具的数量和粒度

- **工具定义每次调用都要发送**，十几个工具的 schema 就有几千 token。
- **工具越多，模型越容易选错**。功能相近的工具要么合并，要么在 description 里写清楚区别。
- 工具很多时，可以**按需加载**：先只给一个「搜索工具」的工具，模型找到需要的工具后，再把它的完整定义加进来。
- 粒度上倾向于**面向任务的粗粒度工具**（「搜索文档」），而不是把底层 API 一比一暴露出去（「执行 SQL」）。粗粒度工具更容易用对，权限也更容易控制。

## MCP：把工具做成可复用的服务

### 解决什么问题

没有 MCP 时，每个 agent 应用要为每个外部系统（GitHub、Slack、数据库……）各写一套集成，N 个应用 × M 个系统 = N×M 份代码。MCP 定义了一个统一的协议：系统方写一个 MCP server，所有支持 MCP 的宿主都能用，N×M 变成 N+M。这个类比和 LSP（Language Server Protocol）之于编辑器是一样的。

### 架构与原语

- **host**（宿主应用，比如 Claude Desktop、IDE）里有多个 **client**，每个 client 和一个 **server** 保持一条连接。
- 消息格式是 **JSON-RPC 2.0**。
- **传输方式**：`stdio`（本地，宿主把 server 作为子进程启动）和 **Streamable HTTP**（远程服务；2025-03-26 版本的规范用它取代了早期的 HTTP + SSE 方式）。远程 server 的鉴权基于 OAuth 2.1。
- **server 提供的原语**：
  - **tools**：模型可以调用的函数，最常用；
  - **resources**：可以读取的数据（文件、数据库记录），由应用决定什么时候放进上下文；
  - **prompts**：预定义的 prompt 模板，通常由用户手动选择。
- **client 提供的能力**：比如 sampling（server 反过来请宿主的模型生成内容）、elicitation（server 通过宿主向用户索要信息）。

### MCP 和 function calling 的关系

宿主连上 MCP server 后，调用 `tools/list` 拿到工具列表，**转换成所用模型 API 的 `tools[]` 格式**发给模型；模型返回 tool call 后，宿主再通过 `tools/call` 转发给对应的 server。所以 MCP 不替代 function calling，它负责的是「工具从哪来、怎么调过去」。

### 安全问题

MCP server 本质上是**第三方代码和第三方数据**：

- **tool poisoning**：恶意 server 在工具的 description 里藏指令，description 会直接进入模型的上下文。
- **rug pull**：server 在你审核通过之后，悄悄修改工具的定义。
- **权限过大**：一个「读邮件」的 server 拿着能发邮件的 token。
- **confused deputy**：server 用自己的高权限凭证替用户执行操作。

所以要像对待依赖包一样审核 MCP server，按最小权限给凭证，对有副作用的调用加人工确认。

### 延伸：DocPilot 可以变成一个 MCP server

DocPilot 的 `search_docs` 和 `read_doc` 已经是定义良好的工具：参数有 pydantic schema，输出里带可以引用的 id。把它们包装成 MCP server，Claude Desktop、Claude Code 这些宿主就能直接检索你的文档库，不需要 DocPilot 自己的聊天界面。agent 循环、引用校验这些逻辑留在 DocPilot 里，检索能力作为一个可复用的服务暴露出去。

## 追问

::: details 模型会直接执行工具吗？整个流程是怎样的？
不会。模型只返回「调用意图」：`stop_reason = tool_use` 加上一组 `{id, name, input}`。应用负责校验参数、决定是否执行、以谁的权限执行，然后把结果作为 `tool_result`（带上对应的 id）加进消息里，再调用一次模型。重复这个过程，直到模型不再请求工具。执行权和安全边界都在应用这一侧。
:::

::: details 怎么写一个好的工具定义？
1. **名字和 description 写清楚做什么、什么时候用、什么时候不要用**，有副作用的工具尤其要写「不要」的情况；
2. **参数要有类型、范围和说明**，用 pydantic 之类的工具从同一个定义生成 schema 并做校验；
3. **限制输出大小**（top_k 上限、截断长文档）；
4. **输出里带上后续步骤需要的标识**，比如可以引用的 chunk id；
5. **数量少、粒度粗、面向任务**，功能相近的要么合并，要么在 description 里写清区别。
:::

::: details 模型传来的工具参数不合法，应该怎么处理？
不要抛异常中断回合，要把具体的错误作为 `is_error=True` 的工具结果回传：参数不是合法 JSON 就带上原始参数的前一部分，不符合 schema 就带上校验错误的详情，工具名不存在就说明不存在。模型看到具体错误后通常会修正再调用。同时在 trace 里记下错误，方便发现 description 写得不清楚的工具。
:::

::: details MCP 和 function calling 有什么区别？
function calling 是模型 API 的能力：模型用什么格式表达「我要调用这个工具」。MCP 是应用层的集成协议：工具由谁提供、怎么发现（`tools/list`）、怎么调用（`tools/call`）。宿主把 MCP server 提供的工具转换成模型 API 的 `tools[]` 格式，模型发起调用后再转发给 server。两者是互补的两层。
:::

::: details MCP 有哪些传输方式？分别适合什么场景？
- **stdio**：宿主把 server 作为本地子进程启动，通过标准输入输出通信。适合本地工具（文件系统、本地 git），不需要网络和鉴权。
- **Streamable HTTP**：远程 server 通过 HTTP 提供服务，响应可以是普通 JSON，也可以是流。适合 SaaS 集成，鉴权基于 OAuth 2.1。它在 2025-03-26 版本的规范里取代了早期的 HTTP + SSE 方式。
:::

::: details 接入第三方 MCP server 有哪些安全风险？
1. **tool poisoning**：工具 description 里藏有指令，会直接进入模型的上下文；
2. **rug pull**：审核通过后，server 修改了工具定义；
3. **权限过大**：给 server 的凭证超出了它需要的范围；
4. **间接注入**：工具返回的数据里带有恶意指令；
5. **confused deputy**：server 用高权限凭证替用户操作。

对策：像审核依赖一样审核 server，固定版本并监控定义的变化，按最小权限发凭证，有副作用的操作需要人工确认，把工具结果当作数据而不是指令。
:::

::: details 给 agent 的工具越多越好吗？
不是。每个工具的 schema 每次调用都要发送，十几个工具就是几千 token；工具越多，模型越容易选错，尤其是功能相近的工具。做法是合并相近的工具，写清区别，按任务只挂载需要的工具，或者先给一个用来搜索工具的工具，按需加载完整定义。
:::

## 参考

- [Anthropic: Tool use overview](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)、[Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [OpenAI: Function calling](https://platform.openai.com/docs/guides/function-calling)
- [Model Context Protocol 规范](https://modelcontextprotocol.io/specification)、[Transports（stdio / Streamable HTTP）](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [MCP: Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
- 实战代码：DocPilot `api/src/docpilot/agent/tools.py`、`agent/loop.py`、`agent/prompts.py`
