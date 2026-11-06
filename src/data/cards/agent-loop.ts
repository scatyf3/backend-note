import type { Card } from '@lib/flashcards'

const R = '/ai/agent-loop'

export const cards: Card[] = [
  {
    id: 'loop-minimal',
    deck: 'ai',
    topic: 'agent 循环',
    q: '写出一个最小的 agent 循环，并列出它要处理的停止条件。',
    qcode: `for step in range(MAX_STEPS):
    resp = model(messages, tools)
    ...`,
    a: '每一轮：调用模型 → 把输出加进 messages → 检查停止条件 → 有 tool call 就执行（并发、错误转成结果）→ 把结果加进 messages → 下一轮。\n停止条件：\n1. **没有 tool call**：最终答案；\n2. **`max_tokens`**：输出被截断，不执行 tool call；\n3. **`refusal`**：拒答；\n4. **步数用完**：如实标记，不假装正常结束；\n5. 生产环境还要有**总时长**和**成本预算**。',
    code: `for step in range(MAX_STEPS):
    resp = model(messages, tools)
    messages.append(resp)
    if resp.stop_reason == "max_tokens": return stop("length")
    if resp.stop_reason == "refusal":    return stop("refused")
    if not resp.tool_calls:              return resp.text
    results = await gather(*(run(c) for c in resp.tool_calls))
    messages.append(tool_results(results))
return stop("step budget exhausted")`,
    ref: `${R}#docpilot-的循环-agent-loop-py`,
  },
  {
    id: 'loop-stop-before-tools',
    deck: 'ai',
    topic: 'agent 循环',
    q: '为什么 agent 循环要在执行工具之前先检查 stop_reason？',
    a: '- **`max_tokens`**：输出在中途被截断，最后一个 tool call 的**参数可能不完整**。执行它可能造成错误甚至危险的副作用，比如 `create_page` 拿到半截的 markdown。\n- **`refusal`**：模型拒绝了，不应该继续执行。\nDocPilot 的循环在这两种情况下直接结束这一轮，标记对应的 finish_reason（`length` / `content-filter`），**不执行任何工具**。stop_reason 决定了这一轮的输出能不能被信任。',
    ref: `${R}#_1-先看-stop-reason-再执行工具`,
  },
  {
    id: 'loop-limits',
    deck: 'ai',
    topic: '上限',
    q: 'agent 循环应该设置哪些上限？只限制步数为什么不够？',
    a: '**步数上限**防死循环（DocPilot 是 6 步），但不够。还需要：\n1. **总时长 deadline**：用户在等；\n2. **token / 成本预算**：每一步都重发全部历史，成本随步数近似平方增长；\n3. **单个工具的超时**：一个卡住的工具会卡住整个回合（DocPilot 的 rerank 有 30 秒 HTTP 超时，数据库查询没有设置）。\n触发上限时要**如实标记**结束原因（DocPilot 用 `finish_reason = "other"`）。',
    ref: `${R}#_2-步数上限-以及上限的语义`,
  },
  {
    id: 'loop-parallel-tools',
    deck: 'ai',
    topic: '工具执行',
    q: '模型一次要求调用多个工具，应该怎么执行？要注意什么？',
    a: '只读、互不依赖的工具**并发执行**（DocPilot 用 `asyncio.gather`），延迟取决于最慢的那个。注意：\n1. 一个工具失败**不能让其他结果丢失**：在每个工具内部捕获异常，转成 `is_error` 结果；\n2. 结果要和 tool call 的 **id 一一对应**地回传；\n3. **有副作用、可能互相冲突**的工具，要禁止并行调用（`parallel_tool_calls: false` / `disable_parallel_tool_use`），或者自己保证可以安全并发。',
    ref: `${R}#_3-同一轮的工具并发执行-错误不中断`,
  },
  {
    id: 'loop-decoupled',
    deck: 'ai',
    topic: '设计',
    q: 'DocPilot 的 agent 循环为什么要做成「产出事件的异步生成器」，并且不依赖 HTTP 和具体的 provider？',
    a: '循环只依赖 provider 中立的接口，对外产出事件：`StepStart`、`TextDelta`、`ToolStarted`、`ToolFinished`、`Done`（带完整 trace）。\n好处：\n1. 路由层把事件编码成 SSE 流，**流式输出**只是一种消费方式；\n2. eval 能通过**同一个接口**重放问题；\n3. 换 provider 不用改循环；\n4. 循环里没有 HTTP 和数据库代码，用假的 provider 和 toolbox 就能**单元测试**。',
    ref: `${R}#_4-循环与-provider、http-都解耦`,
  },
  {
    id: 'loop-infinite',
    deck: 'ai',
    topic: '失败模式',
    q: '怎么防止 agent 陷入死循环，或者不检索就直接编造答案？',
    a: '**死循环**：步数上限兜底；检测连续的、参数完全相同的工具调用，在结果里提示「你已经用同样的参数调用过了」；加时长和成本预算；改进工具描述和错误信息。\n**不检索就编造**：system prompt 明确要求「回答前先调用 search_docs」；eval 里检查有没有发生检索；引用回库校验，没有引用的论断在界面上可见。\n两者都要靠 **trace** 记录每一步，才能被发现。',
    ref: `${R}#循环常见的失败模式`,
  },
  {
    id: 'loop-agent-vs-workflow',
    deck: 'ai',
    topic: '选型',
    q: '什么时候应该用 agent，什么时候用固定的 workflow？DocPilot 为什么选了 agentic RAG？',
    a: '**先用最简单的**：一次调用加检索能解决就不用 agent；步骤固定就用 **workflow**（prompt chaining、routing、parallelization、orchestrator-workers、evaluator-optimizer），可预测、便宜、容易测试。只有**步骤数和路径事先无法确定**的任务（多跳检索、开放式调研、编码）才用 agent，代价是延迟、成本和不可预测性更高。\nDocPilot：eval 里 110 题中有 **37 题是多文档的多跳问题**，「检索一次再回答」处理不了；同时用 6 步上限和明确的 prompt 控制 agent 的不确定性。',
    ref: `${R}#什么时候用-agent-什么时候用-workflow`,
  },
]
