import type { Card } from '@lib/flashcards'

const R = '/ai/llm-gateway'

export const cards: Card[] = [
  {
    id: 'gw-why',
    deck: 'ai',
    topic: 'LLM 网关',
    q: '为什么要在应用和 LLM 供应商之间加一层网关？代价是什么？',
    a: '每个应用都会重复实现重试、供应商切换、缓存、成本统计，网关把它们**集中做一次**：\n1. 统一的 OpenAI 兼容接口，DocPilot 只改 `OPENAI_BASE_URL` 就接入了；\n2. 多供应商**路由和 fallback**；\n3. 按 key 的**限流和预算**；\n4. exact / 语义**缓存**；\n5. **统一计量**（TTFT、p99、命中率、成本）；\n6. 供应商 key 只放在网关上。\n**代价**：多一跳延迟；网关成为一个需要高可用的关键组件。',
    ref: `${R}#为什么需要一个网关`,
  },
  {
    id: 'gw-pipeline',
    deck: 'ai',
    topic: 'LLM 网关',
    q: 'LLMGateway 处理一个 chat 请求的流水线依次是哪些步骤？',
    a: '1. **认证**：按 `sha256(secret)` 查 key；\n2. **限流**：RPM + TPM 两个令牌桶，Lua 原子扣减，超限回 429 + `Retry-After`；\n3. **预算**：每月花费，用完回 **402**；\n4. **路由**：别名 → 规则 → 等级，得到有序的后端链；\n5. **exact cache**，再 **semantic cache**；\n6. **router**：按链尝试，可重试的失败就 fallback；\n7. **响应发出之后**：计费、补扣输出 token、写缓存、记指标（后台任务，不在热路径上）。',
    ref: `${R}#请求流水线`,
  },
  {
    id: 'gw-routing-design',
    deck: 'ai',
    topic: '路由',
    q: 'LLMGateway 的路由由「别名、规则、等级」三部分组成，各自起什么作用？',
    a: '- **别名**：客户端传的 `model` 是别名（fast / smart / best / cheap / local），每个别名对应一条**有序的 fallback 链**。别名也可以用真实模型名（`text-embedding-3-small`），现有客户端不用改。\n- **规则**：按请求特征改写别名，比如超过 3000 token 的 `fast` / `cheap` 请求改走**本地 vLLM**（prefix caching 让长前缀几乎免费）；`smart` / `best` 不擅自降级。\n- **等级**：key 不允许的别名**降级**到等级默认值，原因写进 `x-gateway-route`。',
    ref: `${R}#路由-别名、规则、等级`,
  },
  {
    id: 'gw-fallback-rules',
    deck: 'ai',
    topic: 'fallback',
    q: 'LLM 网关在什么情况下 fallback 到下一个后端？流式请求有什么不同？为什么要关掉 SDK 的自动重试？',
    a: '**只对可重试的失败 fallback**：5xx、429、超时、连接错误。大多数 4xx 原样返回，换一家也修不好坏请求，fallback 只会掩盖 bug、增加延迟。\n**流式**：只在收到上游**第一个 chunk 之前** fallback；之后再换会把两次不同的生成拼在一起，所以只能在流里发 error 事件。\n**关掉 SDK 重试**（`max_retries=0`）：重试由 router 统一负责，叠加的 SDK 重试会在 fallback 之前悄悄放大尾延迟。',
    ref: `${R}#fallback-什么时候换、换到什么时候为止`,
  },
  {
    id: 'gw-token-limit',
    deck: 'ai',
    topic: '限流',
    q: 'LLM 网关的限流为什么要同时限制 RPM 和 TPM？输出 token 事先不知道，怎么限？',
    a: '请求之间的资源消耗差别巨大：一个 10 万 token 的请求顶得上上千个小请求；供应商的限额本来也是 **RPM + TPM** 两个维度。\n输出 token 事先未知：\n1. 请求前按输入**估算**（约 4 字符一个 token）扣 TPM；\n2. 响应结束后按**实际**输出补扣（post-paid）；\n3. **允许令牌桶暂时为负**，下一个请求会等到「欠款」补回来。\n两个桶在一个 Lua 脚本里原子地检查和扣减。',
    ref: `${R}#限流和预算-按-token-算`,
  },
  {
    id: 'gw-observability',
    deck: 'ai',
    topic: '计量',
    q: 'LLMGateway 在响应头里返回哪些信息？为什么「网关自身的开销」是一个关键指标？',
    a: '`x-gateway-backend` / `-model`（实际服务的后端和模型）、`-alias` / `-route`（别名与路由原因）、`-cache`（miss / exact / semantic）、`-cost-usd`（流式 miss 时没有）、`-overhead-ms`、`-semantic-ms`、`-fallbacks`。Prometheus 里按后端和缓存状态统计 TTFT 直方图。\n**开销**（总耗时减去等待模型的时间）是网关要**证明自己值得存在**的数字：加了多少延迟，就要用缓存命中和 fallback 省下的来抵消。',
    ref: `${R}#计量和可观测性`,
  },
  {
    id: 'gw-gaps',
    deck: 'ai',
    topic: '改进',
    q: '读 LLMGateway 的代码，能看出哪些可以继续加强的地方？',
    a: '1. **没有熔断器**：fallback 链顺序固定、后端可用性是静态配置，主后端卡住时每个请求都要先等满 60 秒超时；\n2. **路由不感知健康和延迟**：可以按最近的错误率和 p99 动态调整顺序；\n3. **限流用副本的时间**：时钟偏差会影响令牌补充，改用 Redis `TIME`；\n4. **Redis Cluster**：多 key 的 Lua 脚本和事务需要 hash tag；\n5. **预算是软上限**：需要硬上限就要预留估算成本（TCC）。',
    ref: `${R}#这个网关还缺什么`,
  },
]
