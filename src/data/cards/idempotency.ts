import type { Card } from '@lib/flashcards'

const R = '/backend/idempotency'

export const cards: Card[] = [
  {
    id: 'idem-why-timeout',
    deck: 'backend',
    topic: '幂等',
    q: '为什么分布式系统里，重试必须配合幂等？「超时」意味着什么？',
    a: '超时意味着**结果未知**。客户端无法区分三种情况：1. 请求没到服务端；2. 执行了但响应丢了；3. 还在执行，只是慢。\n不重试，情况 1 会丢请求；重试，情况 2、3 会重复执行。唯一的出路是让**重复执行无害**，这就是幂等：执行多次和执行一次对服务端状态的效果相同。',
    ref: `${R}#为什么-超时等于「结果未知」`,
  },
  {
    id: 'idem-key-impl',
    deck: 'backend',
    topic: '幂等 key',
    q: '幂等 key 的服务端实现流程是什么？两个重复请求同时到达时怎么办？',
    a: '1. 用**唯一约束插入** `(key, 请求体哈希, processing)` 来抢占，不能「先查再插」，那样有竞态。\n2. 抢到的执行业务，完成后存下**完整响应**（status = done）。\n3. 重复请求：done 且请求体哈希一致 → **原样返回**存下的响应；哈希不一致 → 422；还在 processing → 409 或等待。\n同时到达的两个请求只有一个能插入成功。key 要按用户隔离并设置过期时间（Stripe 是 24 小时）。',
    ref: `${R}#_4-幂等-key-通用方案`,
  },
  {
    id: 'idem-exactly-once',
    deck: 'backend',
    topic: '语义',
    q: 'exactly-once 投递真的存在吗？工程上的 exactly-once 是怎么实现的？',
    a: '不可靠的网络上做不到投递层面严格的 exactly-once。工程上指的是**效果上的 exactly-once** = **at-least-once 投递**（不丢）+ **幂等处理**（重复无害）。\n典型做法：消费者把「这条消息 id 已处理」和业务写入放在**同一个事务**里提交；Kafka 的事务把消费位点和输出放进同一个事务。',
    ref: `${R}#_5-消息消费去重`,
  },
  {
    id: 'idem-retryable',
    deck: 'backend',
    topic: '错误语义',
    q: '哪些错误应该重试，哪些不应该？为什么 LLMGateway 遇到 4xx 不 fallback 到别的供应商？',
    a: '**可重试**（前提是幂等）：连接失败、超时、5xx、429（按 `Retry-After`）、408。\n**不可重试**：400 / 401 / 403 / 404 / 422，请求本身有问题，重发结果一样。\nLLMGateway 的 `is_retryable_status` 只对 408 / 409 / 429 / 5xx 返回 true。4xx 说明请求本身是坏的，**换一个供应商也修不好**，fallback 只会掩盖 bug，还白白增加延迟。',
    ref: `${R}#错误语义-哪些能重试`,
  },
  {
    id: 'idem-jitter',
    deck: 'backend',
    topic: '重试',
    q: '重试为什么要用指数退避，还要加抖动（jitter）？',
    a: '- **指数退避**（第 n 次等 $base \\times 2^n$）：给下游恢复的时间，不要在它最虚弱时持续施压。\n- **抖动**：一个依赖短暂故障时，所有客户端几乎同时失败。退避时间固定的话，它们又会**同时重试**，形成周期性尖峰（thundering herd），服务刚恢复就又被打垮。full jitter（在 $[0, base \\times 2^n]$ 里随机取）把重试打散到一个时间窗口里。',
    ref: `${R}#退避、抖动和重试预算`,
  },
  {
    id: 'idem-retry-amplification',
    deck: 'backend',
    topic: '重试',
    q: '什么是重试放大？LLMGateway 为什么把 Anthropic SDK 的 `max_retries` 设成 0？',
    a: '调用链每一层都各自重试，最底层的流量会被指数级放大：**3 层 × 每层 3 次 = 27 倍**，下游过载时直接雪崩。\nLLMGateway 由 router 负责重试和 fallback，叠加的 SDK 重试会在 fallback 发生之前，悄悄地把**尾延迟**放大好几倍。\n原则：**只在一层重试**，配合重试预算、熔断器和 deadline 传播。',
    ref: `${R}#重试放大-只在一层重试`,
  },
  {
    id: 'idem-llm-chat',
    deck: 'backend',
    topic: 'AI 幂等',
    q: 'DocPilot 的 `/chat` 没有幂等 key。前端因为网络抖动重发一次请求，会有什么后果？怎么改？',
    a: '**后果**：服务端再跑一遍完整的 agent 循环，**再扣一次 token 费用**，而且 LLM 不确定，会存下**两条不同的回答**。\n**改法**：用前端 AI SDK 已经带着的消息 id 当幂等 key：已完成的直接返回存下的答案；还在生成的，让新连接**订阅同一个生成过程**（生成和连接解耦），或者返回 409。',
    ref: `${R}#llm-调用贵-而且每次结果不同`,
  },
  {
    id: 'idem-agent-tools',
    deck: 'backend',
    topic: 'AI 幂等',
    q: '为什么 agent 有副作用的工具（如 `create_page`、发邮件）需要幂等？怎么做？',
    a: 'agent 会重复执行：模型可能对同一件事**调用两次工具**，循环里某一步失败后也可能**整步重跑**。DocPilot 的 `create_page` 每次调用都新建文档，被调两次就会出现两篇重复的页面；发邮件、下单的后果更严重。\n做法：用 **`(conversation_id, tool_call_id)`** 这类上下文派生的幂等 key，或者按**内容哈希**去重，重复时返回已有结果的 id。',
    ref: `${R}#agent-的工具调用要幂等`,
  },
]
