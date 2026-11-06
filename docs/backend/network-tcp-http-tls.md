---
title: 网络：TCP / HTTP / TLS
status: draft
tags: [tcp, http, tls, latency]
difficulty: 3
order: 1
related: [/backend/os-io-models, /backend/streaming-sse-websocket, /ai/llm-gateway]
stack: [f-net]
---

# {{ $frontmatter.title }}

## 一句话结论

后端网络问题大多可以归到三件事：==建连要花几个 RTT、队头阻塞（head-of-line blocking）卡在哪一层、连接状态由谁来维护==。HTTP/1.1 → HTTP/2 → HTTP/3 每一代都在把队头阻塞往下挪，TLS 1.2 → 1.3 把握手从 2 个 RTT 压到 1 个。连接池、keep-alive、TLS 在边缘终止这些工程手段，目的都是不让每个请求重新付一次建连的钱。

## 为什么：延迟由 RTT 决定，而 RTT 降不下来

带宽可以花钱买，RTT 受光速限制。光在光纤里大约每毫秒走 200 km，所以：

| 路径 | 典型 RTT |
|---|---|
| 同机房 | < 0.5 ms |
| 同城 / 同 region 跨 AZ | 1–2 ms |
| 美国东西海岸 | ~70 ms |
| 中美之间 | 150–200 ms |

一个新的 HTTPS 请求，在第一个响应字节回来之前要花：

1. TCP 三次握手：**1 RTT**
2. TLS 握手：TLS 1.2 要 **2 RTT**，TLS 1.3 要 **1 RTT**
3. 请求和响应本身：**1 RTT**

跨美国、用 TLS 1.3 的情况下是 3 × 70 = 210 ms，这时服务端一行代码都还没执行。如果是 TLS 1.2，再加 70 ms。所以：

- **连接复用**是最便宜的优化：keep-alive 和连接池把后两个请求的成本压到 1 RTT。
- **TLS 在边缘终止**：CDN 或 LB 离用户近，握手的 RTT 短，后端回源走已经建好的长连接。
- **慢启动**会让新连接的第一个 RTT 只能发大约 10 个 MSS（initcwnd = 10，约 14 KB，见 RFC 6928）。大响应在新连接上要等好几个 RTT 才能把窗口涨上去，这也是长连接更快的原因之一。

## TCP：可靠字节流的代价

### 三次握手为什么是三次

双方都要确认「我能发、对方能收」，并且交换各自的初始序列号（ISN）。两次握手的话，服务端没法确认客户端收到了自己的 ISN；而且网络里滞留的旧 SYN 到达后，服务端会单方面建立连接、白白占资源。第三次 ACK 让客户端确认服务端的 ISN，这样连接状态在两边是对称的。

### 四次挥手、TIME_WAIT 与 CLOSE_WAIT

TCP 是全双工的，两个方向分别关闭，所以要 FIN/ACK 各两次。这里有两个状态在线上最常出问题：

- **TIME_WAIT**：出现在**主动关闭的一方**，持续 2 × MSL（Linux 上固定为 60 s）。它的作用一是保证最后一个 ACK 丢了之后还能重发，二是让旧连接的迟到报文自然过期，不会串到新连接里。短连接打得很密的**客户端**（比如每个请求都新建连接去调下游的服务）会攒出几万个 TIME_WAIT，把本地端口（默认约 28000 个）耗光。对策按优先级是：连接池 > `net.ipv4.tcp_tw_reuse` > 让对端主动关闭。
- **CLOSE_WAIT**：出现在**被动关闭的一方**，表示收到了对端的 FIN，但应用还没调 `close()`。CLOSE_WAIT 堆积几乎都是**应用层 bug**，比如连接泄漏、异常路径上没关 socket，内核参数救不了。

### 拥塞控制与 Nagle

- 慢启动 → 拥塞避免 → 丢包时减半（Reno/CUBIC）。BBR 不把丢包当拥塞信号，而是去测瓶颈带宽和最小 RTT，在长肥管道和有随机丢包的链路上表现更好。
- **Nagle 算法 + delayed ACK** 叠在一起，会让小包请求卡 40 ms 左右：发送方等 ACK 才肯发下一个小包，接收方又在等着攒 ACK。对 RPC、交互式协议要设 `TCP_NODELAY`。大多数 HTTP 客户端和 gRPC 默认已经关了 Nagle。

### backlog 与 SYN flood

`listen()` 有两个队列：半连接队列（收到 SYN）和全连接队列（握手完成、等 `accept()`）。全连接队列满了，新连接就会被丢弃或者 RST，表现为偶发的连接超时。服务端 `accept` 太慢（比如事件循环被阻塞）时就会出现这种情况。SYN flood 攻击打的是半连接队列，用 SYN cookies 防御。

## HTTP：队头阻塞一路往下挪

| 版本 | 传输 | 多路复用 | 队头阻塞在哪 |
|---|---|---|---|
| HTTP/1.1 | TCP，文本 | 无（pipelining 基本没人用） | **应用层**：一个连接上的请求只能排队，所以浏览器对每个域名开大约 6 个连接 |
| HTTP/2 | TCP，二进制分帧 | 一个连接上跑多个 stream，HPACK 压缩头部 | **传输层**：TCP 丢一个包，所有 stream 都要等重传 |
| HTTP/3 | QUIC over UDP | 每个 stream 独立 | 基本消除：一个 stream 丢包只影响它自己 |

HTTP/3 的另外两个好处：

- **QUIC 把传输层握手和 TLS 1.3 合成一次**，新连接 1 RTT 就能发请求。恢复的连接可以 0-RTT。
- **连接迁移**：连接靠 connection ID 识别，不靠四元组，手机从 Wi-Fi 切到蜂窝网络时连接不断。

==0-RTT 的数据可以被重放==，所以只能用来发幂等请求。这和[幂等与错误语义](/stack/api-idempotency)是同一个问题。

服务之间的调用为什么大多还停在 HTTP/2：机房内 RTT 很短、丢包率很低，TCP 队头阻塞几乎不会触发；而 UDP 在很多内网和防火墙环境里会被限速，内核对 QUIC 的支持和卸载也不如 TCP 成熟。gRPC 就建立在 HTTP/2 上。

## TLS 1.3：1-RTT 是怎么做到的

TLS 1.2 先协商算法，再交换密钥，所以要 2 个 RTT。TLS 1.3 做了两件事：

1. **砍掉了 RSA 密钥交换**，只保留 (EC)DHE，所以天然有前向保密（forward secrecy）。
2. 客户端在 ClientHello 里**猜好**大概率会用的曲线，直接把 key share 一起发过去，服务端一个来回就能算出会话密钥。

握手里的另外几个概念：

- **SNI**：在 ClientHello 里明文带上域名，一个 IP 就能托管多张证书。
- **ALPN**：在握手里顺便协商应用层协议（`h2` / `http/1.1`），不用多花一个 RTT。
- **证书链**：服务端要发中间证书，漏发会导致部分客户端报错，常见于新换证书的时候。
- **mTLS**：服务之间双向验证证书，是 service mesh（Istio、Linkerd）做零信任的基础，见[认证与鉴权](/stack/api-auth)。

## 负载均衡：L4 和 L7

- **L4**（按 TCP/UDP 四元组转发）：快，不解析内容，但看不到 URL 和 header，没法按路径路由。如果 L4 后面挂的是 HTTP/2 长连接，所有请求会粘在同一个后端上，负载会不均衡。
- **L7**（解析 HTTP）：能按路径和 header 路由、终止 TLS、重试、限流，代价是多一跳和 CPU 开销。gRPC 的负载均衡一般要用 L7，或者在客户端做负载均衡，就是为了解决上面的长连接粘性问题。

## AI 时代多出来的网络问题：连接变长了

LLM 的流式响应一般要持续几秒到几分钟，而传统 API 是几十毫秒。这会碰到几个以前很少碰到的问题：

- **代理和 LB 的 idle timeout**：比如 AWS ALB 默认 60 s 没有数据就断开连接。推理模型在 thinking 阶段可能很久不吐一个字，所以要发心跳（SSE 的注释行 `: ping`），或者调大超时。
- **代理缓冲**：nginx 默认会把上游响应攒起来再发给客户端，流式输出就变成了等全部生成完再一次性返回。DocPilot 的 `api/src/docpilot/ui_stream.py` 在响应头里加了 `x-accel-buffering: no`，就是为了关掉这层缓冲（详见[流式接口](/stack/api-streaming)）。
- **连接复用对下游同样重要**：DocPilot 的 `retrieval/rerank.py` 每次调用 Cohere rerank 都会新建一个 `httpx.AsyncClient`，用完就关，所以每次 rerank 都要重新付一遍 TCP + TLS 握手（跨 region 时大约 2 个 RTT）。更好的做法是像 embedding client 那样，在 FastAPI 的 `lifespan` 里建一个长期复用的 client。这种问题在 trace 里表现为「rerank 的延迟比 Cohere 报的处理时间多出一截」。

## 追问

::: details 浏览器里输入一个 URL 到页面返回，中间发生了什么？
按层回答，并把每一步花的 RTT 说出来：

1. DNS 解析：先查本地缓存，没有的话问递归解析器，可能要几个 RTT。
2. TCP 握手：1 RTT。
3. TLS 握手：1.3 是 1 RTT，1.2 是 2 RTT；ALPN 在这一步协商出 h2。
4. 发 HTTP 请求：经过 CDN / LB（L7 可能在这里终止 TLS）→ 网关 → 应用 → DB / 缓存。
5. 返回响应：受慢启动影响，大响应要好几个 RTT。
6. 浏览器解析页面，再发出子资源请求，HTTP/2 可以在同一个连接上复用。

面试加分点是给出量级（比如跨洋 RTT 150 ms），并且说出哪些步骤能省：连接复用、TLS 1.3、HTTP/3、CDN。
:::

::: details 大量 TIME_WAIT 是什么问题，怎么办？
TIME_WAIT 出现在主动关闭的一方，持续 60 s（Linux）。如果是客户端这边大量堆积，说明它在用短连接频繁访问下游，可能把本地端口耗光，表现为 `connect` 报 `EADDRNOTAVAIL`。

解决办法按优先级：

1. 用连接池或 keep-alive，从根上减少建连。
2. 打开 `tcp_tw_reuse`：对出站连接安全，依赖 TCP timestamps。
3. 扩大 `ip_local_port_range`。

**不要**用 `tcp_tw_recycle`：它在 NAT 环境下会丢连接，Linux 4.12 已经把它删掉了。
:::

::: details HTTP/2 已经多路复用了，为什么还要 HTTP/3？
HTTP/2 只解决了**应用层**的队头阻塞。底下的 TCP 是一个有序字节流，丢一个包，后面所有 stream 的数据都要等重传，丢包率越高，HTTP/2 越吃亏，甚至可能比开多个连接的 HTTP/1.1 还慢。

QUIC 在 UDP 上为每个 stream 单独做可靠传输，丢包只影响一个 stream。另外它把握手和 TLS 合并成 1 RTT，还支持连接迁移。代价是 UDP 在部分网络里被限速，用户态协议栈的 CPU 开销也更高。
:::

::: details 为什么 TLS 1.3 的 0-RTT 只能发幂等请求？
0-RTT 数据用的是上一次会话留下的 PSK 加密，并且在握手完成**之前**就发出去了。服务端没法确认这些数据是不是被攻击者截获后重放的。如果是 `POST /transfer` 这种请求，重放一次就扣两次钱。所以服务端一般只允许 GET 这类幂等请求走 0-RTT，或者在应用层用幂等 key 去重。
:::

::: details keep-alive 和连接池是一回事吗？
不是一回事，但配合使用：

- **keep-alive** 是协议层面的能力：一个 TCP 连接上可以发多个 HTTP 请求。
- **连接池**是客户端的管理策略：维护一组已经建好的连接，按需借出、用完归还，同时控制最大连接数（保护下游）、空闲超时和健康检查。

Python 里 `httpx.AsyncClient` 自带连接池，前提是复用同一个 client 实例。每个请求都 `async with httpx.AsyncClient()` 等于没有连接池。
:::

::: details 什么时候要设 TCP_NODELAY？
发小包、并且要等回应的交互式协议都要设，比如 RPC、Redis、数据库协议、游戏。原因是 Nagle 算法会攒小包，等前一个包的 ACK 回来才发；而接收方的 delayed ACK 最多会等 40 ms 才回 ACK。两者叠加，就会出现稳定 40 ms 的尾延迟。大块的批量传输不需要设，Nagle 反而能减少包的数量。
:::

## 参考

- [RFC 9293: TCP](https://www.rfc-editor.org/rfc/rfc9293)、[RFC 6928: Increasing TCP's Initial Window](https://www.rfc-editor.org/rfc/rfc6928)
- [RFC 8446: TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446)
- [RFC 9113: HTTP/2](https://www.rfc-editor.org/rfc/rfc9113)、[RFC 9114: HTTP/3](https://www.rfc-editor.org/rfc/rfc9114)、[RFC 9000: QUIC](https://www.rfc-editor.org/rfc/rfc9000)
- Ilya Grigorik, [High Performance Browser Networking](https://hpbn.co/)：讲延迟、TCP、TLS、HTTP/2 最好的一本书，免费在线读
- [AWS ALB idle timeout](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html#connection-idle-timeout)
- 实战代码：DocPilot `api/src/docpilot/ui_stream.py`（SSE 响应头）、`api/src/docpilot/retrieval/rerank.py`（每次调用都新建 client）
