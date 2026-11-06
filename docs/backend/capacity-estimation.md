---
title: 容量估算与高并发设计：从需求算到资源
status: draft
tags: [capacity-planning, estimation, littles-law, scalability, load-testing, system-design]
difficulty: 3
order: 25
related: [/backend/concurrency-models, /backend/caching, /backend/sharding, /backend/replication-consensus, /ai/llm-latency-cost, /ai/tokens-context-window, /backend/rate-limit-circuit-breaker]
stack: [arch-capacity]
---

# {{ $frontmatter.title }}

## 一句话结论

容量估算是把**需求**（日活、每个用户的行为、峰值系数、数据保留多久）换算成**资源**（QPS、并发数、存储、带宽、实例数）的量级计算。连接吞吐和资源的关键公式是 **Little's Law：并发数 = 吞吐 × 平均耗时**。高并发设计则是一组组合手段：无状态的应用层水平扩展、缓存、读写分离、异步削峰、分片、限流降级。==估算的目的不是算准，而是找到瓶颈在哪一层，以及差了几个数量级==。LLM 应用要额外估算两个维度：同时在进行的**长连接数**，和每分钟的 **token 吞吐**，后者常常最先撞上供应商的限额。

## 为什么要估算

系统设计时，「要不要上缓存」「要不要分片」「一个数据库够不够」这些问题，没有数字就只能凭感觉。估算让你能说出：「峰值 1 万 QPS，读写比 10:1，写入 1000 QPS，单个 PostgreSQL 主库能扛，但读要靠缓存加副本；三年数据 5 TB，单机放得下，暂时不需要分片。」这就是面试里系统设计题考的能力。

## 要记住的数字

### 延迟的量级

| 操作 | 量级 |
|---|---|
| 内存访问 | ~100 ns |
| SSD 随机读 | ~几十到一百 µs |
| 同机房网络往返 | ~0.5 ms |
| 机械硬盘寻道 | ~几 ms |
| 跨洲网络往返 | ~150 ms |
| LLM 首 token（短 prompt） | ~0.3–1 s |
| LLM 生成 1000 个 token | ~10–20 s |

量级比精确值重要：内存比 SSD 快约千倍，同机房比跨洲快约几百倍，而一次 LLM 调用比一次数据库查询慢**三到四个数量级**。

### 换算

- 一天约 $10^5$ 秒（86400）；
- 平均 QPS = 日活 × 每人每天请求数 ÷ $10^5$；
- **峰值 QPS** ≈ 平均值 × 2 到 10，取决于业务的潮汐特征。

## 估算的步骤

以「一个有 1000 万日活的应用」为例：

1. **QPS**：每人每天 20 次请求 → $10^7 \times 20 / 10^5 = 2000$ QPS 平均，按 5 倍峰值约 1 万 QPS。
2. **读写比**：10:1 → 写入峰值约 1000 QPS。
3. **存储**：每天新增 $10^7 \times 2$ 条记录 × 1 KB = 20 GB / 天，一年约 7 TB；乘以副本数（比如 3）约 21 TB。
4. **带宽**：1 万 QPS × 平均 10 KB 的响应 = 100 MB/s，约 0.8 Gbps。
5. **实例数**：如果单个实例在 p99 延迟达标的前提下能处理 500 QPS（**压测得出，不是猜的**），就需要 20 个实例，再留 30% 到 50% 的余量。

### Little's Law：从吞吐到资源

$$L = \lambda \times W$$

并发数 = 到达率 × 每个请求的平均耗时。它告诉你需要多少线程、多少连接、多少协程：

- 1000 QPS、平均耗时 50 ms → 同时有 50 个请求在处理；
- 如果每个请求要占用一个数据库连接 20 ms → 平均需要 20 个连接。

### 别忘了数据库的连接数

PostgreSQL 每个连接是一个进程，默认的 `max_connections` 是 100。DocPilot 每个实例的连接池上限是 10（`max_size=10`），扩到 10 个实例，就是 100 个连接，正好撞上默认上限，还没算后台任务和管理连接。==应用层横向扩容的时候，数据库连接数是最容易被忽略的天花板==，这时就需要 PgBouncer 这类连接池代理（见[索引、事务与隔离级别](/backend/sql-index-transaction)）。

## LLM 应用的容量估算

传统应用的瓶颈通常是数据库，LLM 应用多了两个维度。

### 并发长连接

一次 LLM 回答要持续 10 到 30 秒，按 Little's Law：

- 每秒 50 个新对话 × 每个回答 20 秒 = **同时有 1000 个流式连接**。

这个数字决定了：每个实例要承载多少个 SSE 连接、LB 和代理的连接上限、滚动发布时要排空多少个流（见[容器、K8s 与 CI/CD](/backend/containers-cicd)）。按 QPS 规划，会严重低估这里需要的资源。

### token 吞吐

用 DocPilot 的典型回答来估（见[延迟与成本模型](/ai/llm-latency-cost)）：一个三步的 agent 回答，累计输入约 16.8K token，输出约 600 token。

- 每秒 50 个对话 × 约 17.4K token ≈ 每秒 87 万 token ≈ **每分钟 5200 万 token**。

这远远超过单个 API key 常见的 TPM 限额。所以必须提前规划：

- 供应商的限额要提前申请提升，或者分散到多个 key、多家供应商（这正是 [LLM 网关](/ai/llm-gateway)要做的事）；
- prompt caching 和上下文压缩能直接降低 token 吞吐（见[上下文压缩](/stack/ctx-compaction)）；
- 非实时的任务走队列和 batch 接口，削平峰值（见[后台任务](/backend/background-jobs)）。

agent 每一步都重发全部历史，输入 token 随步数近似平方增长（见 [Token 与上下文窗口](/ai/tokens-context-window)），所以**步数上限也是容量规划的一部分**。

### 自托管模型

自托管时，瓶颈变成了 GPU：显存装下权重之后，剩下的空间决定了 KV cache 能容纳多少并发序列；decode 受显存带宽限制。这部分估算见[自托管推理还是调 API](/stack/ai-selfhost)。

## 高并发的常用手段

按「先做简单的」的顺序：

1. **应用层无状态，水平扩展**：状态放进数据库或 Redis，实例前面加负载均衡（LLMGateway 的设计：每个容器一个进程，状态全在 Redis）。
2. **缓存**：挡掉大部分读请求（见[缓存](/backend/caching)）；对 LLM 应用来说还有 prompt caching 和语义缓存。
3. **读写分离**：读请求走只读副本，注意复制延迟（见[复制与一致性](/backend/replication-consensus)）。
4. **异步削峰**：不需要立即完成的写入和重活放进队列（见[消息队列](/stack/mq-broker)）。
5. **CDN**：静态资源和可缓存的响应放在边缘。
6. **分片**：单机写入或存储撑不住时（见[分片](/backend/sharding)）。
7. **限流和降级**：超出容量的部分有序拒绝，保住核心功能（见[限流、熔断与重试](/backend/rate-limit-circuit-breaker)）。

找瓶颈的顺序通常是：数据库的写入 → 连接数 → 缓存的命中率 → 外部依赖（对 LLM 应用来说，就是供应商的限额和延迟）。

## 压测：验证估算

估算给出量级，压测给出事实。LLMGateway 的压测设计是一个不错的样板：

- **阶梯加压**：按每秒 5、10、20、40 个请求逐步加压，每一级跑 60 秒，每一级结束后抓取一次 Prometheus 指标，观察延迟和错误率在哪个压力下开始恶化；
- **故障注入**：在压力达到某一级时，通过管理接口把主后端「切断」20 秒，测量 fallback 的成功率；
- **可以核对的数据**：合成的请求里事先混入了 15% 的完全重复请求和 10% 的近似重复请求，每条请求都标记了类型，所以测出来的缓存命中率可以和真实的重复比例对照；
- **测量方式**：客户端测量 TTFT（第一个内容 token 的到达时间）；Windows 上用 `127.0.0.1` 而不是 `localhost`，避免 IPv6 回退带来的假的长尾延迟（见[延迟与成本模型](/ai/llm-latency-cost)）。

压测时要注意：用接近真实分布的请求（LLMGateway 也支持用 ShareGPT 的真实对话来生成请求）；每轮测试前清空缓存和计数器；看 p99，而不是平均值。

## 追问

::: details 估算：1000 万日活，每人每天 20 次请求，平均和峰值 QPS 大约是多少？
一天约 $10^5$ 秒，平均 QPS = $10^7 \times 20 / 10^5 = 2000$。峰值按 2 到 10 倍的潮汐系数，取 5 倍约 1 万 QPS。读写比 10:1 的话，写入峰值约 1000 QPS。这些数字用来判断数据库能不能扛、需要多少应用实例、要不要缓存。
:::

::: details Little's Law 是什么？在后端容量规划里怎么用？
并发数 = 到达率 × 平均耗时（L = λW）。用来把吞吐换算成需要同时占用的资源：1000 QPS、每个请求 50 ms，就有 50 个请求同时在处理，需要相应数量的线程、协程或连接；每个请求占用数据库连接 20 ms 的话，平均需要 20 个连接。LLM 场景下，每秒 50 个对话、每个持续 20 秒，就是 1000 个并发的流式连接。
:::

::: details 应用层横向扩容时，为什么数据库连接数会成为瓶颈？
PostgreSQL 每个连接是一个进程，默认 `max_connections` 是 100。每个应用实例都有自己的连接池，实例数 × 每个实例的池大小很快就会超过上限。比如 DocPilot 每个实例最多 10 个连接，10 个实例就到了 100。解决办法：在数据库前面加 PgBouncer 这类连接池代理，或者减小每个实例的池大小，并注意事务池化模式对会话级设置的影响。
:::

::: details 估算一个 LLM 聊天应用的容量，和传统 Web 应用相比要多考虑什么？
1. 并发长连接：一次回答持续 10 到 30 秒，按 Little's Law，每秒 50 个对话就是约 1000 个同时在进行的流式连接，按 QPS 规划会严重低估；
2. token 吞吐：每分钟的 token 数常常最先撞上供应商的 TPM 限额，agent 的多步调用会让输入 token 成倍增加；
3. 成本随 token 线性增长。

应对：提前申请限额或分散到多个 key、多家供应商，prompt caching，限制步数，非实时任务走队列和 batch。
:::

::: details 一个系统需要扛住高并发，常用的手段有哪些？优先级怎么排？
先做简单的：应用层无状态、水平扩展；加缓存；读写分离；异步削峰；CDN；最后才是分片。全程配合限流和降级，超出容量的部分有序拒绝。找瓶颈的顺序通常是数据库写入、连接数、缓存命中率、外部依赖。每一步都要用压测数据验证，而不是凭感觉。
:::

::: details 怎么设计一次有说服力的压测？
1. 用接近真实分布的请求，最好来自真实的流量记录；
2. 阶梯加压，找到延迟和错误率开始恶化的拐点；
3. 在压力下做故障注入，验证 fallback 和降级；
4. 请求里事先标注已知的特征（比如 LLMGateway 混入 15% 的完全重复和 10% 的近似重复），让测出来的命中率可以核对；
5. 每轮前清空缓存和计数器，看 p99，排除测量工具本身的问题。
:::

## 参考

- Jeff Dean, [Latency Numbers Every Programmer Should Know](https://gist.github.com/jboner/2841832)
- Alex Xu, *System Design Interview*，第 2 章（量级估算）
- [Little's law（维基百科）](https://en.wikipedia.org/wiki/Little%27s_law)
- [PostgreSQL: max_connections](https://www.postgresql.org/docs/current/runtime-config-connection.html)、[PgBouncer](https://www.pgbouncer.org/)
- [Locust](https://docs.locust.io/)
- 实战代码：LLMGateway `loadtest/`（`run_steps.py`、`prompt_trace.py`、`locustfile.py`）与 README「Load test」一节；DocPilot `db.py`（`max_size=10`）
