import type { Card } from '@lib/flashcards'

const R = '/backend/durable-execution'

export const cards: Card[] = [
  {
    id: 'durable-what',
    deck: 'backend',
    topic: 'durable execution',
    q: 'durable execution 解决了什么问题？它和普通的任务队列有什么区别？',
    a: '**问题**：多步流程中途崩溃，从头重来会**重复执行副作用**（重复扣库存），不重来又会**卡在中间**。\n**任务队列**只保证单个任务能被执行和重试，多步之间的状态、顺序、超时、补偿都要自己用状态列加 cron 拼起来，流程逻辑分散。\n**durable execution** 把整个流程写成一段代码，每一步的结果持久化成**事件历史**，崩溃后**重放**恢复到断点，还内置了长时间等待、外部信号、超时和重试。',
    ref: `${R}#为什么-多步流程的状态放在哪`,
  },
  {
    id: 'durable-replay',
    deck: 'backend',
    topic: 'Temporal',
    q: 'Temporal 是怎么在 worker 崩溃后恢复一个 workflow 的？',
    a: '引擎把每个 workflow 的关键事件（调度了哪个 activity、activity 的结果、定时器、收到的信号）记进**事件历史**。\n新的 worker 拿到历史后，**从头重新执行 workflow 代码**：遇到已经有结果的 activity，**直接返回记录下来的结果**，不会真的再执行；重放到历史末尾后，接着正常执行。',
    ref: `${R}#怎么做到「崩溃后接着跑」`,
  },
  {
    id: 'durable-determinism',
    deck: 'backend',
    topic: 'Temporal',
    q: '为什么 workflow 代码必须是确定性的？哪些写法会破坏确定性？',
    a: '恢复靠**重放**：workflow 代码重新执行时，必须做出和第一次**完全相同的决定**，才能和事件历史对得上。\n破坏确定性的写法：直接读**当前时间**、用**随机数**、直接调用外部服务或读文件、开线程、遍历顺序不确定的集合，以及**改了代码却没做版本化**。\n这些要改用引擎的 API（`workflow.now()`、`workflow.random()`），或者放进 activity 里。',
    ref: `${R}#怎么做到「崩溃后接着跑」`,
  },
  {
    id: 'durable-workflow-activity',
    deck: 'backend',
    topic: 'Temporal',
    q: 'workflow 和 activity 分别放什么代码？为什么 activity 必须幂等？',
    a: '- **workflow**：编排逻辑（顺序、分支、等待、补偿），**必须确定，不能有副作用**。\n- **activity**：有副作用的操作（调 API、写数据库、调用 LLM），可以失败，由引擎按重试策略重试，有执行超时和心跳超时。\n**幂等**：activity 执行成功了，但结果还没写进历史时 worker 崩溃，引擎会**再执行一次**。可以用「workflow id + 步骤名」作为幂等 key。',
    ref: `${R}#两种代码`,
  },
  {
    id: 'durable-versioning',
    deck: 'backend',
    topic: 'Temporal',
    q: '线上还有几千个运行中的 workflow 实例，这时要修改 workflow 代码，怎么办？',
    a: '直接改代码的话，旧实例重放时会和历史对不上，报**非确定性错误**。\n做法：\n1. **版本化**：在代码里加版本标记（Temporal 的 `patched`），旧实例走旧分支，新实例走新分支；所有旧实例都结束后，再删掉旧分支；\n2. 或者用**新的 workflow 类型**承接新的执行，旧类型保留到旧实例跑完。',
    ref: `${R}#其他能力`,
  },
  {
    id: 'durable-history-limit',
    deck: 'backend',
    topic: 'Temporal',
    q: 'Temporal 单个 workflow 执行的事件历史有什么上限？长期运行的 workflow 怎么处理？',
    a: '上限是 **51,200 个事件或 50 MB**（10,240 个事件或 10 MB 时开始告警），超过就会被**终止**。历史越大，重放和交接也越慢。\n长期运行的 workflow（比如一个永远在线的订阅流程）要定期调用 **continue-as-new**：关闭当前执行，用同一个 workflow id 开启一个新的执行，带上必要的状态，事件历史从零开始。',
    ref: `${R}#其他能力`,
  },
  {
    id: 'durable-step-functions',
    deck: 'backend',
    topic: 'Step Functions',
    q: 'AWS Step Functions 的 Standard 和 Express 两种 workflow 有什么区别？各适合什么场景？',
    a: '- **Standard**：最长 **1 年**，**exactly-once** 执行（除非配置了重试）。适合长流程和**非幂等**的操作，比如支付。\n- **Express**：最长 **5 分钟**；异步执行是 **at-least-once**，同步执行是 at-most-once。适合高频、短时、**幂等**的事件处理。',
    ref: `${R}#aws-step-functions`,
  },
  {
    id: 'durable-agents',
    deck: 'backend',
    topic: 'agent',
    q: '为什么说 agent 特别适合放在 durable execution 引擎上运行？',
    a: '1. **每一步都贵**：跑到第 17 步崩溃，从头再来会浪费前 16 次 LLM 调用；\n2. **每一步都不确定**：把每次 LLM 调用作为 activity、结果记进历史，**重放时直接用记录的结果，就是确定的**，正好满足 workflow 的确定性要求；\n3. **有副作用的工具**在重放时不会重复执行；\n4. **人工审批**可能要等几小时，用 signal 等待，不占资源；\n5. 每个 agent 实例在哪一步、做了什么，都能直接查到。\nDocPilot 的循环在 HTTP 请求的内存里跑，最多 6 步，问答场景够用，长任务就需要迁过去。',
    ref: `${R}#agent-就是一个需要-durable-execution-的工作流`,
  },
]
