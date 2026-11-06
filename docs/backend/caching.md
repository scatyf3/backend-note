---
title: 缓存：模式、失效与三大问题
status: draft
tags: [cache, redis, consistency, cache-aside]
difficulty: 3
order: 9
related: [/backend/sql-index-transaction, /backend/concurrency-models, /ai/prompt-semantic-cache, /ai/sampling-nondeterminism]
stack: [st-cache]
---

# {{ $frontmatter.title }}

## 一句话结论

缓存用空间换时间：把慢的读（数据库、下游服务、LLM）的结果放到快的地方。难点不在「放」，而在三个问题：==缓存什么、什么时候失效、失效那一刻怎么不把源头打垮==。最常用的是 **cache-aside** 模式：读时没命中就回源再写回缓存；写时**先更新数据库、再删除缓存**。需要防住三大问题：**穿透**（查不存在的 key）、**击穿**（热点 key 过期）、**雪崩**（大量 key 同时失效或者缓存整体宕机）。LLM 时代，缓存的价值更大了，因为一次回源可能要几秒和几美分；但「什么样的请求算同一个请求」变得更难判断。

## 为什么：命中率决定一切

有效延迟：

$$t = h \cdot t_{cache} + (1 - h) \cdot t_{origin}$$

更重要的是**回源量** = $(1-h) \times$ 总请求数。命中率从 90% 提到 99%，回源流量降到原来的十分之一。所以缓存是保护数据库的第一道防线；反过来，缓存一旦失效，数据库会瞬间承受 10 倍、100 倍的压力，这就是三大问题的根源。

### 缓存在哪一层

| 层 | 例子 | 特点 |
|---|---|---|
| 客户端 / 浏览器 | HTTP `Cache-Control`、`ETag` | 最近，但不受你控制 |
| CDN | 静态资源、可缓存的 GET | 离用户近，按 URL 缓存 |
| 应用进程内 | LRU dict、Caffeine | 最快（纳秒级），但每个实例一份，一致性难保证 |
| 分布式缓存 | Redis、Memcached | 亚毫秒级，多个实例共享 |
| 数据库内部 | buffer pool、page cache | 自动管理 |

## 读写模式

| 模式 | 读 | 写 | 适用 |
|---|---|---|---|
| **cache-aside**（旁路） | 应用先查缓存，没命中就查 DB 再写回 | 应用写 DB，然后**删除**缓存 | 最通用 |
| read-through | 缓存层负责回源 | | 缓存组件支持时 |
| write-through | | 同步写缓存和 DB | 读多、需要缓存始终是最新的 |
| write-behind | | 只写缓存，异步刷到 DB | 写多、能容忍丢数据（计数器） |

### cache-aside 写路径：为什么是「先更新 DB，再删缓存」

**为什么删缓存而不是更新缓存**：

1. 两个并发写入，可能以「DB 是 B、缓存是 A」的顺序完成，导致长期不一致；删除没有这个顺序问题。
2. 写了缓存未必有人读，删除是懒加载，用到的时候再算。
3. 缓存的值可能是多张表 join 的结果，「更新」的逻辑很复杂。

**为什么先更新 DB，再删缓存**：反过来（先删缓存、再更新 DB），在这两步之间，一个读请求没命中，会把**旧值**读回缓存，而且这个旧值会一直留到过期。

先更新 DB 再删缓存，仍然有一个很小的竞态窗口：读请求在 DB 更新之前读到旧值，又在删除缓存之后才写回。但这个窗口需要「读 DB 比写 DB + 删缓存还慢」，概率很低。常见的补救办法：

- **TTL 兜底**：任何不一致最多持续一个 TTL。
- **延迟双删**：写完之后过几百毫秒再删一次。
- **基于 CDC 的失效**：订阅数据库的变更日志（binlog / WAL），由一个独立的组件负责删缓存，删除失败可以重试，也不依赖应用代码记得去删。

==缓存本质上是最终一致的==。业务上不能容忍短暂旧数据的读（比如支付后的余额），就直接读主库。

## 三大问题

### 穿透：查一个根本不存在的 key

缓存里没有，DB 里也没有，所以每次都打到 DB。可能是恶意请求（随机 id），也可能是 bug。

- **缓存空值**：DB 返回空，也写一个短 TTL 的空标记。
- **布隆过滤器**：先判断 key 是否可能存在，「肯定不存在」就直接返回。布隆过滤器有误判（说存在但其实不存在），不会漏判。
- 入口做参数校验和限流。

### 击穿：一个热点 key 过期了

一个热门的 key 过期的瞬间，成千上万个请求同时没命中，同时去查 DB 重建同一个值（cache stampede / dogpile）。

- **单飞（single-flight）/ 互斥锁**：只让一个请求回源，其他请求等它的结果。进程内用一个 in-flight 的 Future，跨进程用 Redis 的 `SET key NX PX` 加锁（协程版本的竞态见[并发模型](/backend/concurrency-models)）。
- **逻辑过期**：值里存一个过期时间，物理上不过期；读到逻辑过期的值时，先返回旧值，同时由一个请求在后台刷新（stale-while-revalidate）。
- **提前随机刷新**：快过期时按概率提前刷新，比如 XFetch 算法。

### 雪崩：大量 key 同时失效，或者缓存挂了

- **TTL 加随机抖动**：比如 3600 s ± 10%，避免同一批写入的 key 同时过期。
- **缓存高可用**：Redis 主从 + 哨兵或 Cluster。
- **多级缓存**：进程内缓存挡住一部分流量。
- **源头保护**：限流、熔断、降级，宁可返回旧数据或默认值，也不能把 DB 打挂（见[限流、熔断与重试](/stack/ds-resilience)）。
- **预热**：发布或重启前，先把热点数据加载进缓存。

## 其他实践

- **淘汰策略**：LRU 淘汰最久没用的，LFU 淘汰最少使用的。LFU 对「偶尔一次的大扫描」更有抵抗力。Redis 用 `maxmemory-policy` 配置，常用 `allkeys-lru` / `allkeys-lfu`。
- **热 key**：单个 key 的 QPS 超过单个 Redis 分片的承受能力时，在应用进程里加一层本地缓存，或者把 key 复制成多份（`key#1..N`）随机读。
- **大 key**：一个几 MB 的 value 会阻塞 Redis 的单线程，删除时也会阻塞，要拆分，或者用 `UNLINK` 异步删除。
- **key 要带版本**：数据结构变了，就改 key 前缀（`v2:user:42`），不需要清空整个缓存。
- **只缓存成功的结果**：失败、超时、半截的响应都不要缓存，否则会把一次故障固化下来。

## LLM 时代的缓存

LLM 调用又慢又贵，一次命中可能省下好几秒和几美分，所以缓存的收益比传统接口大得多。但「同一个请求」的定义变复杂了：

| 层 | 缓存什么 | 判断「相同」的依据 |
|---|---|---|
| **provider 的 prompt caching** | 相同前缀对应的 KV cache，由供应商实现 | 前缀逐 token 完全一致 |
| **网关的 exact cache** | 完整的响应 | 规范化之后的请求哈希 |
| **语义缓存** | 完整的响应 | 问题的 embedding 足够相似 |
| **embedding 缓存** | 文本对应的向量 | 文本完全相同 |

LLMGateway 的实现里有几个和传统缓存一脉相承的点：

- **规范化 key**：sha256 计算的输入包括 alias、消息内容（去掉首尾空白）和所有影响答案的参数，JSON 的 key 排序；排除 `stream`、`user` 这些不影响答案的字段。
- **不是所有请求都能缓存**：只缓存 temperature 为 0 的请求，因为缓存一个随机样本会改变语义（见[采样与非确定性](/ai/sampling-nondeterminism)）。
- **只缓存成功的响应**：流式转发里，只有完整结束（状态 200）的响应才写缓存；中途失败或客户端断开的，都不写。
- **写缓存不在热路径上**：在响应发给客户端之后，由后台任务写入 Redis。
- **TTL**：exact 和 semantic 都配置了 `ttl_s: 3600`。

DocPilot 目前没有响应缓存，但有两个现成的机会：

1. **embedding 缓存**：同一段文本（重复上传的文档、eval 每次重新灌入的语料、常见的问题）每次都会重新算 embedding。用 `(模型名, 维度, 文本哈希)` 作为 key 就能缓存，而且 embedding 是确定性的，不存在一致性问题。
2. **长期复用客户端对象**：`app.py` 在 `lifespan` 里创建连接池、embedder、LLM client，存在 `app.state` 里给所有请求共享。这本身也是一种「缓存」：缓存的是连接和 TLS 会话（反例见[网络](/backend/network-tcp-http-tls)里每次新建 client 的 rerank）。

prompt caching 和语义缓存的细节见 [Prompt caching 与语义缓存](/stack/gw-cache)。

## 追问

::: details cache-aside 模式下，更新数据时应该先删缓存还是先更新数据库？为什么是删而不是更新缓存？
先更新数据库，再删缓存。反过来的话，在「删缓存」和「更新 DB」之间，读请求会把旧值读回缓存，并一直留到过期。

删而不是更新的原因：并发写入时，更新缓存的顺序可能和更新 DB 的顺序不一致，导致长期不一致；删除是懒加载，不用的数据不必计算；复杂的缓存值更新起来很麻烦。剩下的小竞态窗口用 TTL、延迟双删或 CDC 失效来兜底。
:::

::: details 缓存穿透、击穿、雪崩分别是什么？怎么解决？
- **穿透**：查不存在的 key，每次都打到 DB。缓存空值（短 TTL）、布隆过滤器、参数校验。
- **击穿**：一个热点 key 过期，大量请求同时回源。single-flight 互斥、逻辑过期（先返回旧值、后台刷新）、提前随机刷新。
- **雪崩**：大量 key 同时过期，或者缓存宕机。TTL 加抖动、缓存高可用、多级缓存、源头限流和降级、预热。
:::

::: details 怎么保证缓存和数据库的一致性？
做不到强一致，缓存本质上是最终一致的。要做的是缩小不一致的窗口：先写 DB 再删缓存；所有 key 设置 TTL 兜底；用 CDC 订阅数据库变更来删缓存（可靠，并且和业务代码解耦）；对一致性要求高的读直接走主库。还要明确业务能容忍多久的旧数据。
:::

::: details LRU 和 LFU 有什么区别？什么时候用 LFU？
LRU 淘汰最久没访问的，LFU 淘汰访问次数最少的。LRU 会被一次性的大扫描冲刷掉（扫描过的冷数据挤走了热数据）；LFU 对这种情况更有抵抗力，适合热点稳定的访问模式。Redis 的 LFU 带衰减，不会让历史热点永远占着位置。
:::

::: details 一个 key 的 QPS 太高，单个 Redis 节点扛不住，怎么办？
1. 在应用进程里加一层本地缓存（短 TTL），挡住绝大部分读；
2. 把 key 复制成多份（`key#1..N`），随机读其中一份，分散到不同的分片；
3. 对热点做识别和监控（Redis 的 `--hotkeys`，或者客户端埋点）。

本地缓存的代价是更新有延迟，适合能接受几秒旧数据的场景。
:::

::: details LLM 应用里有哪几层缓存？分别用什么判断「同一个请求」？
1. **provider 的 prompt caching**：相同前缀的 KV cache，要求前缀逐 token 一致，所以固定的 system prompt 和工具定义要放在最前面并保持稳定；
2. **网关的 exact cache**：规范化后的请求哈希，只缓存 temperature 0 的请求；
3. **语义缓存**：问题的 embedding 相似度超过阈值，要按 system prompt 和历史隔离命名空间，阈值要严格；
4. **embedding 缓存**：文本完全相同，结果是确定性的，最安全。
:::

::: details 为什么失败或者半截的响应不能写进缓存？
缓存会把一次临时故障固化下来：之后所有命中的请求都拿到错误的结果，直到过期。LLMGateway 的流式转发只在响应完整结束、状态为 200 时才写缓存；上游中途失败（502）或客户端断开（499）的都不写。传统接口同理：5xx 不缓存；如果要缓存「不存在」，要和错误区分开，并且用短 TTL。
:::

## 参考

- [AWS: Caching Best Practices](https://aws.amazon.com/caching/best-practices/)
- Nishtala et al., [Scaling Memcache at Facebook](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala)（lease 机制解决击穿和旧值问题）
- Vattani et al., [Optimal Probabilistic Cache Stampede Prevention](https://cseweb.ucsd.edu/~avattani/papers/cache_stampede.pdf)（XFetch）
- [Redis: Key eviction](https://redis.io/docs/latest/develop/reference/eviction/)
- [RFC 5861: stale-while-revalidate](https://www.rfc-editor.org/rfc/rfc5861)
- 实战代码：LLMGateway `gateway/cache/exact.py`、`gateway/pipeline.py`（只在状态 200 时写缓存）、`config/gateway.yaml`；DocPilot `app.py`（`lifespan`）
