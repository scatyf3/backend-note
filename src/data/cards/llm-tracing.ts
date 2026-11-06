import type { Card } from '@lib/flashcards'

const R = '/ai/llm-tracing'

export const cards: Card[] = [
  {
    id: 'trace-what',
    deck: 'ai',
    topic: 'LLM tracing',
    q: '一条完整的 LLM trace 应该记录哪些信息？',
    a: '1. **上下文**：会话、用户、模型、**prompt 版本**；\n2. **每一步模型调用**：token（区分缓存）、TTFT、耗时、**结束原因**；\n3. **每次工具调用**：名称、参数、结果摘要、耗时、是否出错；\n4. **检索到的内容 id**；\n5. **最终输出**、引用及其校验结果；\n6. **成本**。\n还要记录**失败和被中断的轮次**，它们往往最需要排查。用 span 组织，可以采用 OpenTelemetry 的 GenAI 语义约定。',
    ref: `${R}#一条-llm-trace-应该长什么样`,
  },
  {
    id: 'trace-vs-distributed',
    deck: 'ai',
    topic: 'LLM tracing',
    q: 'LLM trace 和分布式追踪有什么区别和联系？',
    a: '- **分布式追踪**：请求在多个服务之间的调用链和耗时，回答「**慢在哪个服务**」。\n- **LLM trace**：一个回答的生成过程，包括检索到了什么、调了哪些工具、每一步的 token 和成本，回答「**为什么是这个答案、花了多少钱**」。\n联系：可以用同一套 span 模型（OpenTelemetry 的 GenAI 语义约定，比如 `gen_ai.usage.input_tokens`），用**同一个 trace id** 关联起来。',
    ref: `${R}#为什么普通的日志和指标不够`,
  },
  {
    id: 'trace-docpilot-schema',
    deck: 'ai',
    topic: '实战',
    q: 'DocPilot 的 `traces` 表存了什么？trace 是怎么呈现给用户的？',
    a: '每轮 assistant 回答一行：`message_id`（唯一、级联删除）、`retrieved_chunk_ids`（按首次出现顺序去重）、`tool_calls`（JSON：名称、参数、摘要、是否出错、耗时）、`model`、累计的 `input_tokens` / `output_tokens`、`latency_ms`、`cost_usd`。\n呈现：流末尾发 `data-trace` 事件，界面上每条回答下有可展开的 Trace 面板；展开时调用 `GET /traces/{id}`，服务端按 id 查出 chunk 原文一起返回。trace 和问答在**同一个事务**里写入。',
    ref: `${R}#实战-docpilot-的-trace`,
  },
  {
    id: 'trace-ids-not-text',
    deck: 'ai',
    topic: '实战',
    q: 'DocPilot 的 trace 里为什么只存 chunk id，不存原文？代价是什么？',
    a: '**好处**：\n1. **不重复存储**：同一个 chunk 被检索多少次，原文都只存一份；\n2. **尊重删除**：文档删除后 chunk 级联删除，trace 里的 id 关联不到原文，自然不再显示，对隐私和数据删除请求更友好。\n**代价**：文档删除或重新入库后，**无法完整还原**当时模型看到的内容。需要严格审计的场景，要在保留期内存一份快照。',
    ref: `${R}#只存-id-不存原文`,
  },
  {
    id: 'trace-docpilot-gaps',
    deck: 'ai',
    topic: '实战',
    q: '从「排查一个错误回答需要什么」来看，DocPilot 的 trace 还缺哪些东西？',
    a: '1. **每一步模型调用的明细**：现在只有整轮累计，看不出哪一步最慢、最贵；\n2. **TTFT**；\n3. **prompt 版本**；\n4. **结束原因**：截断、拒答、步数用完只发给了前端，没有存下来；\n5. **失败的轮次没有 trace**：异常走 `encoder.fail()`、客户端断开时生成器被取消，都不会走到 `save_turn`，最需要排查的情况反而没有记录；\n6. **缓存命中的 token**，用上 prompt caching 后计算成本需要。',
    ref: `${R}#还缺什么`,
  },
  {
    id: 'trace-gateway-vs-app',
    deck: 'ai',
    topic: '分层',
    q: '网关层的 trace（LLMGateway）和应用层的 trace（DocPilot）各能看到什么？怎么把它们关联起来？',
    a: '- **网关**：每次模型调用的后端、模型、token、成本、TTFT、缓存命中、fallback；但**不知道**这次调用属于哪个对话的哪一步，看不到工具和检索。\n- **应用**：完整的回答过程（步骤、工具、检索、引用）；但看不到网关内部的 fallback 和缓存命中。\n**关联**：应用调用网关时，在请求头里带上 trace id（`traceparent` 或 `x-request-id`），网关记进日志和指标。DocPilot 目前没有传。',
    ref: `${R}#网关的-trace-和应用的-trace`,
  },
  {
    id: 'trace-uses',
    deck: 'ai',
    topic: 'LLM tracing',
    q: 'LLM trace 有哪些用途？trace 里的数据有什么隐私风险，怎么控制？',
    a: '**用途**：1. **排查**错误回答；2. 按功能、用户、模型、prompt 版本**归因成本**；3. 采样被点踩、出错、步数耗尽的 trace，标注后加进**离线 eval 数据集**；4. **线上自动评估**；5. **审计**结论依据了哪些文档。\n**隐私**：trace 里有用户问题、prompt、工具参数，可能含个人信息。控制办法：**最小化**（存 id 和摘要而不是原文）、完整内容设**短保留期**、**访问控制**、**跟随用户删除**。',
    ref: `${R}#trace-的几种用途`,
  },
]
