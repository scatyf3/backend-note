---
title: 可观测性：指标、日志、追踪与 SLO
status: draft
tags: [observability, metrics, logging, tracing, slo, prometheus, opentelemetry]
difficulty: 3
order: 20
related: [/backend/containers-cicd, /backend/rate-limit-circuit-breaker, /ai/llm-tracing, /ai/llm-gateway, /ai/llm-latency-cost]
stack: [ops-observability]
---

# {{ $frontmatter.title }}

## 一句话结论

可观测性是指：==只靠系统对外输出的信号，就能回答「系统内部正在发生什么、为什么」==。三类信号各有所长：

- **指标**（metrics）：聚合后的数字，便宜，适合画趋势、做告警；
- **日志**（logs）：离散事件的细节，适合排查某一次具体的问题；
- **追踪**（traces）：一个请求跨越多个服务和步骤的因果链，适合定位慢在哪、错在哪。

把它们串起来的是 **trace id**。告警应该基于 **SLO**（用户能感知到的服务目标）和错误预算，而不是基于 CPU 这类原因指标。还有一个容易被忽视的工程约束：**指标的标签必须是低基数的**，否则时序数据库会爆炸。

## 为什么需要三种信号

一个用户说「刚才回答特别慢」，排查的过程大致是：

1. **指标**告诉你：过去 10 分钟 p99 延迟从 3 秒涨到了 40 秒，而且只有走 Anthropic 后端的请求变慢了。（是不是普遍问题？影响多大？从什么时候开始？）
2. **追踪**告诉你：某个慢请求的 40 秒里，有 38 秒花在等待第一个后端超时上，然后 fallback 到了 OpenAI。（慢在哪一步？）
3. **日志**告诉你：那次超时对应的错误信息、请求参数、fallback 的原因。（具体发生了什么？）

只有指标，知道出事了但不知道为什么；只有日志，信息淹没在海量的行里，看不出全局；只有追踪，没法做告警和长期趋势。

## 指标

### 三种基本类型

- **counter**：只增不减的计数（请求总数、错误总数、花费总额），看它的**变化率**；
- **gauge**：可以上下变化的瞬时值（在途请求数、队列深度、内存）；
- **histogram**：把观测值落进预先定义好的分桶，用来算分位数（延迟分布）。

### 为什么延迟要用直方图，而不是平均值

平均值会掩盖长尾：99 个 100 毫秒的请求加上 1 个 30 秒的请求，平均是 400 毫秒，看起来没什么问题，但那 1% 的用户等了 30 秒。延迟要看 **p50 / p95 / p99**。

两个注意点：

- **分位数不能求平均**：两台机器各自的 p99 求平均，不是整体的 p99。要用直方图：各实例的分桶计数可以直接相加，再从合并后的直方图计算分位数。Prometheus 的 `histogram_quantile` 就是这么做的。
- **分桶要按业务的延迟范围来设**：LLMGateway 的 `metrics.py` 给不同的指标定义了不同的分桶。请求延迟和 TTFT 用 10 毫秒到 64 秒，因为 LLM 请求可能持续几十秒；网关自身的开销用 0.5 毫秒到 250 毫秒，因为它应该在毫秒级。用默认分桶的话，要么长尾全挤在最后一个桶里，要么亚毫秒的开销根本分辨不出来。

### 选哪些指标：RED 和 USE

- **RED**（面向服务）：**R**ate（请求速率）、**E**rrors（错误率）、**D**uration（延迟分布）。每个服务、每个接口都应该有。
- **USE**（面向资源）：**U**tilization（使用率）、**S**aturation（饱和度，比如排队长度）、**E**rrors。用于 CPU、内存、连接池、队列。

LLMGateway 的指标基本就是 RED 加上 LLM 特有的部分：请求总数（按接口、后端、模型、状态、缓存）、端到端延迟、TTFT、网关开销、token 数（按 key、模型、方向）、花费、缓存省下的钱、缓存查询结果、fallback 次数（按别名、来源后端、原因）、被限流的次数（见 [LLM 网关](/ai/llm-gateway)）。

### 基数：最容易踩的坑

时序数据库里，**每一种标签值的组合都是一条独立的时间序列**。给指标加上 `user_id` 标签，有 100 万用户就是 100 万条序列乘以其他标签的组合，存储和查询都会崩溃。

LLMGateway 的 `metrics.py` 开头写明了原则：标签保持**低基数**，用 API key 的 id 而不是用户，后端和模型来自配置而不是自由文本，所以时序数据库的规模可控。它还调用了 `disable_created_metrics()`，去掉 Prometheus 客户端默认附带的 `_created` 序列，那些序列会让抓取的数据量翻倍却没什么用。

==高基数的信息（用户 id、请求 id、prompt 内容）放进日志和追踪，不放进指标的标签==。

## 日志

- **结构化**：输出 JSON，而不是拼接的字符串，这样才能按字段搜索和聚合。
- **带上关联 id**：每一行都带 trace id / request id，才能把同一个请求的所有日志串起来。
- **分级和采样**：DEBUG 级别默认不开；高频的成功请求可以采样，错误要全量记录。
- **不要记录敏感数据**：LLM 应用尤其要注意，prompt 里可能有个人信息和机密。LLMGateway 的语义缓存命中日志是一行 JSON，记录的是相似度、阈值和两边 prompt 的 **sha256 前缀**，而不是 prompt 原文：既能审计误命中（两个哈希对应的请求可以另行查证），又不会把用户内容写进日志系统（见[数据隐私与 PII](/stack/sec-privacy)）。

## 分布式追踪

- 一个 **trace** 代表一个请求的完整生命周期，由多个 **span**（一次操作：一次 HTTP 调用、一次数据库查询、一次 LLM 调用）组成，span 之间有父子关系和时间。
- **上下文传播**：调用下游时，在请求头里带上 trace id 和父 span id（W3C 标准是 `traceparent` 头），下游据此把自己的 span 挂到同一棵树上。跨消息队列时，要把上下文放进消息的元数据里（见[Outbox 与事件驱动](/stack/mq-outbox)）。
- **OpenTelemetry** 是事实标准：统一的 API 和 SDK，可以导出到 Jaeger、Tempo、Datadog 等任意后端。
- **采样**：全部记录太贵。**头部采样**在请求开始时按比例决定，简单但可能漏掉罕见的错误；**尾部采样**在请求结束后决定，可以保留所有错误和慢请求，但需要先把 span 缓冲起来。

### 应用层的 trace

DocPilot 没有接入分布式追踪，但它在 `traces` 表里为**每一轮回答**存了一条记录：检索到的 chunk id、每次工具调用（名称、参数、摘要、是否出错、耗时）、模型、token、延迟、成本。这是一种面向 LLM 应用的「业务级追踪」，回答的是「这个回答是怎么来的」，而不只是「慢在哪个服务」，详见 [LLM tracing](/stack/ev-tracing)。两者是互补的：分布式追踪看系统性能，LLM trace 看回答质量和成本。

## SLO 与告警

- **SLI**（指标）：比如「成功且 TTFT < 2 秒的请求占比」。
- **SLO**（目标）：比如「30 天内 SLI ≥ 99.5%」。
- **错误预算**：1 − SLO = 0.5%，就是允许出错的额度。预算还多，就可以放心发布、做实验；预算快用完了，就冻结发布，专注于稳定性。

告警的原则：

- **针对症状，而不是原因**：用户感知到的错误率和延迟超标才告警，CPU 90% 本身不一定是问题。
- **按燃烧速率告警**：错误预算消耗得有多快。比如「1 小时内消耗了 2% 的月度预算」立即呼叫；「6 小时内消耗了 5%」发工单。同时用长短两个时间窗口，既能快速发现严重故障，又不会被短暂的抖动反复打扰。
- 每一条告警都应该是**需要人立即采取行动的**，否则就是噪音，噪音会让人习惯性地忽略告警。

## LLM 应用要额外关注的信号

传统的 RED 指标之外：

- **TTFT 和每秒输出 token 数**，按供应商和模型分别统计；
- **token 用量和成本**，按应用、用户、功能分别统计；
- **缓存命中率**和省下的成本；
- **fallback 次数和原因**；
- **质量相关的信号**：拒答率、用户点踩率、引用校验失败的比例。这类信号要靠 eval 和 trace 来支撑（见[离线 eval](/stack/ev-offline)、[线上回归](/stack/ev-online)）。

## 追问

::: details 指标、日志、追踪分别适合回答什么问题？
指标是聚合的数字，便宜，适合看趋势和做告警（是不是出事了、影响多大）；追踪是一个请求的完整因果链，适合定位慢在哪一步、错在哪个服务；日志是离散事件的细节，适合查看某一次具体发生了什么。三者用 trace id 关联起来。
:::

::: details 为什么延迟要看分位数而不是平均值？多台机器的 p99 能直接平均吗？
平均值会掩盖长尾：1% 的请求慢到 30 秒，平均值可能仍然很好看。要看 p50 / p95 / p99。多台机器的 p99 不能直接平均，要用直方图：各实例的分桶计数相加，再从合并后的直方图算分位数。分桶要按业务的延迟范围设，LLMGateway 的请求延迟分桶到 64 秒，网关开销分桶到亚毫秒。
:::

::: details 什么是 RED 方法和 USE 方法？
RED 面向服务：请求速率、错误率、延迟分布，每个服务和接口都应该有。USE 面向资源：使用率、饱和度（排队长度）、错误，用于 CPU、内存、连接池、队列。服务层出问题时用 RED 发现症状，再用 USE 查资源层的原因。
:::

::: details 什么是指标的高基数问题？怎么避免？
时序数据库里每一种标签值组合都是一条独立的序列。把用户 id、请求 id、URL 原文这种取值无限的字段作为标签，序列数会爆炸，存储和查询都会崩溃。避免办法：标签只用有限的、来自配置的值（服务名、后端、模型、状态码、API key id），高基数的信息放进日志和追踪。LLMGateway 的 `metrics.py` 开头就写明了这条原则。
:::

::: details 分布式追踪是怎么把多个服务的调用串起来的？头部采样和尾部采样有什么区别？
调用下游时，在请求头（W3C `traceparent`）里带上 trace id 和父 span id，下游把自己的 span 挂到同一棵树上；跨消息队列时把上下文放进消息元数据。头部采样在请求开始时按比例决定是否记录，简单，但可能漏掉罕见的错误；尾部采样等请求结束后再决定，可以保留所有错误和慢请求，但要先缓冲 span，成本更高。
:::

::: details SLO 和错误预算是什么？告警应该怎么设计？
SLI 是衡量服务质量的指标（比如成功且 TTFT < 2 秒的请求占比），SLO 是目标（30 天内 ≥ 99.5%），错误预算是允许的失败额度（0.5%）。预算充足时可以放心发布，快耗尽时冻结发布。告警要针对用户能感知的症状，而不是 CPU 这类原因；按错误预算的燃烧速率告警，同时用长短两个时间窗口；每条告警都应该需要人立即处理。
:::

::: details LLM 应用的日志要注意什么？
prompt 和回答里可能有个人信息和机密，默认不要把原文写进日志系统，或者先脱敏、设置短保留期和严格的访问控制。需要审计时，可以记录哈希，比如 LLMGateway 的语义缓存命中日志只记录 prompt 的 sha256 前缀和相似度。每行日志都要带上 trace id，方便和 LLM trace、分布式追踪关联。
:::

## 参考

- [Google SRE Book: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)、[SRE Workbook: Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)
- Tom Wilkie, [The RED Method](https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/)、Brendan Gregg, [The USE Method](https://www.brendangregg.com/usemethod.html)
- [Prometheus: Histograms and summaries](https://prometheus.io/docs/practices/histograms/)、[Instrumentation（标签基数）](https://prometheus.io/docs/practices/instrumentation/#do-not-overuse-labels)
- [OpenTelemetry](https://opentelemetry.io/docs/)、[W3C Trace Context](https://www.w3.org/TR/trace-context/)
- 实战代码：LLMGateway `gateway/metrics.py`、`gateway/cache/semantic.py`（命中日志）、`deploy/prometheus.yml`、`deploy/grafana/`；DocPilot `schema.sql`（`traces` 表）、`app.py`（`/healthz`）
