---
title: LLM 网关：路由、fallback、限流与计量
status: draft
tags: [llm-gateway, routing, fallback, rate-limit, observability]
difficulty: 4
order: 14
related: [/backend/rate-limit-circuit-breaker, /backend/idempotency, /ai/provider-api-structured-output, /ai/prompt-semantic-cache, /ai/llm-latency-cost, /backend/streaming-sse-websocket, /backend/api-design]
stack: [gw-routing]
---

# {{ $frontmatter.title }}

## 一句话结论

LLM 网关是位于应用和多家模型供应商之间的一层：对外提供**统一的 API**（通常兼容 OpenAI），对内做**路由**（按别名、规则、等级选择模型）、**fallback**（按链尝试，失败了换下一个）、**按 key 的限流和预算**、**缓存**和**计量**（token、成本、TTFT）。==它就是把第 5 层的那些韧性模式，套用到 LLM 这种「慢、贵、会限流、偶尔大面积故障」的依赖上==，再加上几条 LLM 特有的规则：流式请求只在首字节之前 fallback，限流按 token 计算、输出 token 事后结算，预算耗尽返回 402 而不是 429。

## 为什么需要一个网关

LLMGateway 的 README 开头讲的就是这个动机：每个调用 LLM 的应用，最后都会重新实现一遍重试、供应商切换、缓存和成本统计。把这些集中在网络的边缘做一次：

- **一处实现，所有应用受益**：DocPilot 只要把 `OPENAI_BASE_URL` 指向网关，就自动获得了多供应商 fallback、缓存和计量；
- **一处度量**：TTFT、p99、缓存命中率、每个请求的成本，都在网关上统一测量；
- **一处管控**：供应商的 API key 只放在网关上，应用拿到的是网关签发的 key（只存哈希，见[认证与鉴权](/backend/auth)）；按应用、按用户设置限额和预算；换模型不需要改应用代码。

## 请求流水线

LLMGateway 的整个请求路径写在一个函数里（`gateway/pipeline.py` 的 `chat_completions`），读下来就是：

1. **认证**：Bearer key，按 `sha256(secret)` 查找。
2. **限流**：每个 key 两个令牌桶（每分钟请求数、每分钟 token 数），一个 Lua 脚本原子地检查并扣减，超限返回 429 和 `Retry-After`。
3. **预算**：每个 key 每月的花费存在 Redis，用完返回 **402 `insufficient_quota`**。
4. **路由**：别名 → 规则 → 等级，得到一个有序的后端链。
5. **exact cache**，然后 **semantic cache**（见 [Prompt caching 与语义缓存](/ai/prompt-semantic-cache)）。
6. **router**：按链依次尝试后端，可重试的失败就 fallback。
7. **响应发出之后**（后台任务）：计费、补扣输出 token、写缓存、记录指标。

## 路由：别名、规则、等级

### 别名是一条有序的 fallback 链

客户端发送的 `model` 是一个**别名**，不是具体的模型名：

```yaml
fast:
  - {backend: anthropic, model: claude-haiku-5-5}
  - {backend: openai,    model: gpt-4.1-mini}
  - {backend: mock-primary, model: mock-small}
smart:
  - {backend: anthropic, model: claude-sonnet-5-5}
  - {backend: openai,    model: gpt-4.1}
text-embedding-3-small: *embed   # 别名可以用真实的模型名，现有的客户端不用改代码
```

应用只表达「要快的」还是「要聪明的」，具体用哪家、哪个型号，由网关的配置决定。没有配置凭证的后端会被直接跳过，不算一次 fallback。

### 规则：按请求的特征改写别名

```yaml
rules:
  - name: long-prompts-to-local    # 长 prompt 在 vLLM 上能吃到 prefix caching 的收益
    min_prompt_tokens: 3000
    aliases: [fast, cheap]         # 只改写这两个；smart / best 按调用方的要求处理
    route_to: local
```

长 prompt 的 prefill 是最贵的部分，自托管的 vLLM 有 prefix caching，重复的长前缀几乎不花钱（见[延迟与成本模型](/ai/llm-latency-cost)）。注意规则只作用于 `fast` 和 `cheap`：调用方明确要 `smart` 或 `best` 时，网关不擅自降级。

### 等级：按 key 限制能用的模型

`free` 等级的 key 只能用 `fast`、`cheap`、`local` 这几个别名；请求了不允许的别名（比如 `smart`），就降级到这个等级的默认别名。降级的原因写在响应头 `x-gateway-route` 里，调用方能看到发生了什么。

## Fallback：什么时候换、换到什么时候为止

规则集中写在 `gateway/router.py` 里（详见[幂等与错误语义](/backend/idempotency)和[流式接口](/backend/streaming-sse-websocket)）：

- **可重试的失败才 fallback**：5xx、429、超时、连接错误。大多数 4xx 原样返回，因为换一家也修不好一个格式错误的请求，fallback 只会掩盖 bug、增加延迟。
- **流式请求只在首字节之前 fallback**：router 先等到上游的第一个 chunk（受 `timeout_s` 限制），才把流交给客户端。之后再失败，只能在流里发一个 error 事件，否则会把两家不同的生成拼成一个回答。
- **SDK 的自动重试关掉**（`max_retries=0`）：重试由 router 统一负责，叠加的 SDK 重试会在 fallback 之前悄悄放大尾延迟。
- **可观测**：每次 fallback 都按「别名、从哪个后端、原因」打一个指标，响应头里有 `x-gateway-fallbacks`。

## 限流和预算：按 token 算

LLM 的限流和普通 API 有两点不同：

1. **要同时限制请求数和 token 数**：供应商的限额本来就是 RPM + TPM 两个维度。一个 10 万 token 的请求和一个 100 token 的请求，消耗的资源完全不同。
2. **输出 token 在请求时未知**：LLMGateway 先按输入估算（约 4 字符一个 token）扣 TPM，响应结束后再按实际的输出 token 补扣，允许桶暂时变成负数（post-paid）。

预算是每个 key 每月的花费上限，用完返回 **402**，而不是 429：OpenAI SDK 会自动重试 429，而预算要到下个月才恢复，重试毫无意义（见 [API 设计](/backend/api-design)）。预算是**软上限**：请求之前只检查、不预留，计费在响应之后，并发请求会超支一点。改成硬上限需要先预留估算的成本，也就是 TCC 的思路（见[分布式事务](/stack/ds-txn)）。

## 计量和可观测性

每个响应都带着一组头：

| 响应头 | 含义 |
|---|---|
| `x-gateway-backend` / `x-gateway-model` | 实际服务这次请求的后端和模型 |
| `x-gateway-alias` / `x-gateway-route` | 请求的别名、路由的原因（规则、等级降级） |
| `x-gateway-cache` | `miss` / `exact` / `semantic` |
| `x-gateway-cost-usd` | 这次请求的成本（流式 miss 时没有，因为发头的时候还不知道） |
| `x-gateway-overhead-ms` | 网关自身的开销（总耗时减去等待模型的时间） |
| `x-gateway-semantic-ms` | 语义缓存的 embedding 调用耗时 |
| `x-gateway-fallbacks` | 发生了几次 fallback |

Prometheus 指标里，TTFT 按后端和缓存状态分别统计直方图，Grafana 上能直接看到每家供应商的 p50 / p99。==网关最重要的数字之一是它自己的开销==：如果网关加了 50 毫秒，就要能证明它省下的（缓存、fallback）比这多。

## 这个网关还缺什么

读代码时能看出几处可以继续加强的地方，面试时主动讲出来，比只讲做了什么更有说服力：

1. **没有熔断器**：fallback 链是固定顺序，后端的可用性是静态配置。主后端卡住时，每个请求都要先等满 60 秒超时才会切换。加一个按后端统计的熔断器，就能在几次失败后直接跳过它（见[限流、熔断与重试](/backend/rate-limit-circuit-breaker)）。
2. **路由不感知健康状况和延迟**：可以根据最近的错误率和 p99 动态调整链的顺序，甚至把一部分流量分给次优的后端来持续探测。
3. **限流用的时间来自网关副本**：多个副本之间的时钟偏差会影响令牌的补充量，可以改用 Redis 的 `TIME`。
4. **Redis Cluster 下的多 key 操作**：限流和语义缓存的多 key 脚本需要 hash tag（见[分片](/backend/sharding)）。
5. **预算是软上限**：需要硬上限的场景要加预留。

## 自己做，还是用现成的

现成的方案很多：开源的 LiteLLM Proxy，托管的 OpenRouter、Portkey、Cloudflare AI Gateway，以及 API 网关产品自带的 AI 插件。它们覆盖了多供应商兼容、路由、限流、缓存、计量这些核心功能。自己实现的价值在于：完全掌握 fallback 和计费的语义，能针对自己的流量做定制（比如长 prompt 路由到自托管模型），而且做一遍之后，对每一个设计取舍都有第一手的理解。

## 追问

::: details 为什么要在应用和 LLM 供应商之间加一个网关？
每个应用都要重复实现重试、供应商切换、缓存、成本统计；网关把它们集中做一次：统一的 OpenAI 兼容接口、多供应商路由和 fallback、按 key 的限流和预算、缓存、统一计量（TTFT、p99、命中率、成本）。供应商的 key 只放在网关上，换模型也不用改应用代码。代价是多一跳的延迟，以及网关本身成为一个需要高可用的关键组件。
:::

::: details LLMGateway 的路由是怎么决定用哪个后端的？
三步：
1. 客户端传的 `model` 是别名，对应一条有序的后端链；
2. 规则按请求特征改写别名，比如 prompt 超过 3000 token 的 `fast` / `cheap` 请求改走本地 vLLM，因为那里有 prefix caching；
3. 等级检查，key 不允许使用的别名降级到该等级的默认别名，原因写进 `x-gateway-route`。

最后 router 按链依次尝试，跳过没有凭证的后端。
:::

::: details 网关在什么情况下 fallback？流式请求有什么特殊之处？
只对可重试的失败 fallback：5xx、429、超时、连接错误；大多数 4xx 原样返回，换一家也修不好坏请求。流式请求只在收到上游第一个 chunk 之前 fallback；客户端一旦开始收到内容，再换后端会把两次不同的生成拼在一起，所以之后的失败只能在流里发 error 事件。网关还关掉了 SDK 的自动重试，避免多层重试叠加。
:::

::: details LLM 的限流为什么要同时限制请求数和 token 数？输出 token 事先不知道，怎么限？
请求之间的资源消耗差别巨大，一个 10 万 token 的请求顶得上上千个小请求，供应商的限额本来也是 RPM 和 TPM 两个维度。输出 token 事先未知：先按输入估算扣 TPM，响应结束后按实际输出补扣，允许令牌桶暂时为负，下一个请求会等到「欠款」补回来。两个桶在一个 Lua 脚本里原子地检查和扣减。
:::

::: details 一个 LLM 网关应该暴露哪些指标？
每个后端的 TTFT 和总延迟分布（p50 / p99）、错误率和 fallback 次数（按原因）、缓存命中率（exact / semantic）和省下的成本、每个 key 的 token 用量和花费、限流和预算拒绝的次数，以及网关自身的开销（总耗时减去等待模型的时间）。LLMGateway 在响应头里给出每个请求的这些信息，并用 Prometheus 汇总。
:::

::: details 如果主供应商卡住不响应（不是返回错误），这个网关会怎样？怎么改进？
router 每次都会先尝试主供应商，等满 `timeout_s`（配置是 60 秒）超时之后才 fallback，故障期间所有请求都多花 60 秒，协程和连接也会被大量占用。改进：加按后端统计的熔断器，连续超时或错误率过高时打开，后续请求直接跳过它，冷却后放探测请求确认恢复；流式请求的首 token 超时可以设得更短；进一步可以根据最近的健康状况动态调整 fallback 链的顺序。
:::

## 参考

- [LiteLLM Proxy](https://docs.litellm.ai/docs/simple_proxy)、[OpenRouter](https://openrouter.ai/docs)、[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [OpenAI API: Rate limits（RPM / TPM）](https://platform.openai.com/docs/guides/rate-limits)、[Anthropic: Rate limits](https://docs.anthropic.com/en/api/rate-limits)
- 实战代码：LLMGateway `gateway/pipeline.py`、`gateway/router.py`、`gateway/limits.py`、`gateway/auth.py`、`config/gateway.yaml` 与 README「Design decisions and trade-offs」一节；DocPilot README「Using the LLM Gateway」一节
