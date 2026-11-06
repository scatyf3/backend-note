import type { Card } from '@lib/flashcards'

const R = '/ai/tool-calling-mcp'

export const cards: Card[] = [
  {
    id: 'tool-who-executes',
    deck: 'ai',
    topic: 'tool calling',
    q: 'tool calling 时模型会直接执行工具吗？一次完整的工具调用流程是怎样的？',
    a: '**不会**。模型只返回**调用意图**：`stop_reason = tool_use` + `[{id, name, input}]`。\n应用负责：**校验参数 → 决定是否执行、以谁的权限执行 → 执行** → 把 `tool_result{tool_use_id, content, is_error}` 加进 messages → 再次调用模型，直到模型不再请求工具。\n推论：执行权和安全边界都在应用这一侧；工具结果是模型的**输入**，所以也是 prompt injection 的入口。',
    ref: `${R}#为什么-模型只会生成文本`,
  },
  {
    id: 'tool-pydantic-schema',
    deck: 'ai',
    topic: '工具设计',
    q: 'DocPilot 用同一个 pydantic 模型来定义工具参数。它解决了什么问题？`extra="forbid"` 和 `le=10` 各起什么作用？',
    a: '同一个类的 `model_json_schema()` 生成给模型看的 **JSON Schema**，`model_validate()` 校验模型返回的参数，所以 **schema 和校验永远不会对不上**。\n- `extra="forbid"`：模型多传了字段就立刻报错，说明它理解错了，把错误回传让它修正。\n- `top_k` 的 `le=10`：防止模型一次要几百条结果、**撑爆后续每一步的上下文**。',
    ref: `${R}#_1-一个-pydantic-模型同时生成-schema-和做校验`,
  },
  {
    id: 'tool-error-to-model',
    deck: 'ai',
    topic: '工具设计',
    q: '模型调用了不存在的工具、传了不合法的 JSON、或者工具执行时抛异常，应该怎么处理？为什么？',
    a: '**不要抛异常中断回合**，要把具体的错误作为 `is_error=True` 的工具结果回传给模型：\n- 未知工具：`unknown tool \'xxx\'`\n- JSON 不合法：附上原始参数的前 200 个字符\n- schema 校验失败：附上 pydantic 的错误详情\n- 执行异常：异常类型 + 消息\n模型看到具体的错误通常会**修正参数再调一次**。对模型来说，清楚的错误信息就是修复指引。',
    ref: `${R}#_3-错误回传给模型-而不是抛异常`,
  },
  {
    id: 'tool-outcome-audiences',
    deck: 'ai',
    topic: '工具设计',
    q: 'DocPilot 的 `ToolOutcome` 为什么把一次工具执行的结果拆成 result、output、summary、chunk_ids 四份？',
    a: '因为它们服务**不同的受众**：\n- `result` → **模型**：完整内容，chunk 用 `<chunk id doc_id title>` 包起来，模型才能引用 id；\n- `output` → **界面**：结构化的简洁展示（标题、分数、200 字摘要）；\n- `summary` → **trace**：一行可检索的描述；\n- `chunk_ids` → 记录模型看过哪些内容，用于之后的**引用校验**。\n用同一份数据凑合，要么模型信息不够，要么界面和 trace 被塞满。',
    ref: `${R}#_4-一次执行-三种受众`,
  },
  {
    id: 'tool-good-definition',
    deck: 'ai',
    topic: '工具设计',
    q: '怎样写一个好的工具定义？为什么工具不是越多越好？',
    a: '**好的定义**：1. description 写清楚做什么、**什么时候用、什么时候不要用**（DocPilot：create_page「只有用户要求时才调用」）；2. 参数有类型、范围和说明；3. 限制输出大小；4. 输出里带后续步骤需要的标识（可引用的 id）；5. 面向任务、粗粒度。\n**不是越多越好**：每个工具的 schema **每次调用都要发送**，十几个工具就是几千 token；工具越多越容易选错。要合并相近的工具，或者按需加载。',
    ref: `${R}#_6-工具的数量和粒度`,
  },
  {
    id: 'tool-mcp-vs-fc',
    deck: 'ai',
    topic: 'MCP',
    q: 'MCP 和 function calling 是什么关系？MCP 解决了什么问题？',
    a: '**两层**：function calling 是模型 API 的能力，管模型**怎么表达调用**；MCP 是应用层的集成协议，管工具**从哪来、怎么调过去**。宿主用 `tools/list` 拿到 MCP 工具，转成模型 API 的 `tools[]`；模型发起调用后，宿主再用 `tools/call` 转发给 server。\n**解决的问题**：N 个 agent 应用 × M 个外部系统，原本要 N×M 份集成，标准化之后变成 **N+M**，类似 LSP 之于编辑器。',
    ref: `${R}#mcp-和-function-calling-的关系`,
  },
  {
    id: 'tool-mcp-transport-primitives',
    deck: 'ai',
    topic: 'MCP',
    q: 'MCP server 提供哪三种原语？有哪两种传输方式，各适合什么场景？',
    a: '**原语**：\n- **tools**：模型可以调用的函数；\n- **resources**：可读取的数据，由应用决定什么时候放进上下文；\n- **prompts**：预定义的模板，通常由用户选择。\n**传输**（消息格式是 JSON-RPC 2.0）：\n- **stdio**：宿主把 server 作为本地子进程启动，适合本地工具；\n- **Streamable HTTP**：远程服务，鉴权基于 OAuth 2.1，在 2025-03-26 版规范中取代了早期的 HTTP + SSE。',
    ref: `${R}#架构与原语`,
  },
  {
    id: 'tool-mcp-security',
    deck: 'ai',
    topic: 'MCP',
    q: '接入第三方 MCP server 有哪些安全风险？怎么应对？',
    a: '1. **tool poisoning**：工具 description 里藏指令，会直接进入模型上下文；\n2. **rug pull**：审核通过后 server 悄悄修改工具定义；\n3. **权限过大**：凭证超出 server 实际需要的范围；\n4. **间接注入**：工具返回的数据里带恶意指令；\n5. **confused deputy**：server 用高权限凭证替用户操作。\n应对：像审核依赖包一样审核 server、固定版本并监控定义变化、**最小权限**发凭证、有副作用的操作加人工确认、把工具结果当作**数据**而不是指令。',
    ref: `${R}#安全问题`,
  },
]
