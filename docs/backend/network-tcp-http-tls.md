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

==一个请求的耗时 ≈ 要等几个 RTT × RTT + 排队等待==。
1. RTT 受光速限制降不下来，所以后端网络优化只有两个方向：**少等几个 RTT**，**少排队**。
2. 复用连接同时省掉了握手和慢启动的 RTT，是最便宜的优化；
3. 但复用带来了新问题：同一个连接上的请求要互相等，也就是队头阻塞（head-of-line blocking）。HTTP/1.1 → HTTP/2 → HTTP/3 的演进，就是在回答「怎么复用连接又不排队」。

![网络延迟概览图：(a) 新连接与复用连接上一个请求的时间构成；(b) 各机制所在的协议层；(c) 长连接带来的运维问题](/diagrams/network-overview.svg)

**图 1　网络延迟概览。** (a) 一个请求的时间构成。新连接要先付握手和慢启动的 RTT（蓝），复用连接把它们省掉，代价是同一连接上的请求要排队等待（橙色斜线）。(b) 这些机制分别在哪一层：蓝色对应「少等 RTT」，橙色对应「少排队」。(c) 连接复用、活得久了以后要面对的问题。

这篇的读法（每一项后面标了它对应「少等 RTT」还是「少排队」）：

**TCP 层**

1. [三次握手与四次挥手](#三次握手-每一步在做什么)：经典八股，也是后面几节的背景。握手本身要 1 个 RTT（**少等 RTT**）；握手完成后连接进的队列，就是 backlog 那节的主角。
2. [拥塞控制](#拥塞控制-一次能发多少)：也交给 TCP 负责（HTTP/3 里由 QUIC 负责）。动机是：瓶颈带宽未知，又不能把它打爆，所以从小流量开始越发越多，丢包了就降速；之后有经典算法（Reno、CUBIC）和不看丢包、直接测量的升级版（BBR）。和延迟直接相关的是慢启动：新连接发大响应要好几个 RTT（**少等 RTT**）。
3. [Nagle 与 delayed ACK](#nagle-与-delayed-ack-两个优化撞在一起)：两者都想少发包、减少通信开销，叠在一起却会空等 40 ms，交互式协议要关掉 Nagle（**少排队**）。
4. [backlog](#backlog-握手完成后在哪排队)：握手完成的连接在内核队列里等应用 `accept()`，应用取得慢、队列满了，请求就会偶发超时（**少排队**）。

**TCP 之上：TLS 与 HTTP**

TLS 夹在 TCP 和 HTTP 中间，不属于 HTTP 层：先建 TCP 连接，再握手 TLS，HTTP 跑在 TLS 上面。

1. [TLS 1.3](#tls-1-3-1-rtt-是怎么做到的)：让 TLS 握手只要 1 个 RTT（**少等 RTT**）。
2. [HTTP/1.1 → 2 → 3](#http-队头阻塞一路往下挪)：一步步消除队头阻塞（**少排队**）。

**连接活得久之后**

[TIME_WAIT 与 CLOSE_WAIT](#四次挥手、time-wait-与-close-wait)、[L4 / L7 负载均衡](#负载均衡-l4-和-l7)、[LLM 的长连接](#ai-时代多出来的网络问题-连接变长了)：连接复用、活得久了以后，状态由谁维护、出了问题怎么查。

## 为什么：延迟由 RTT 决定，而 RTT 降不下来

带宽可以花钱买，RTT 受光速限制。光在光纤里大约每毫秒走 200 km，所以：

| 路径 | 典型 RTT |
|---|---|
| 同机房 | < 0.5 ms |
| 同城 / 同 region 跨 AZ | 1–2 ms |
| 美国东西海岸 | ~70 ms |
| 中美之间 | 150–200 ms |

### 一个请求要等几个 RTT

**建连要等。** 一个新的 HTTPS 请求，在第一个响应字节回来之前要花：

1. TCP 三次握手：**1 RTT**
2. TLS 握手：TLS 1.2 要 **2 RTT**，TLS 1.3 要 **1 RTT**
3. 请求和响应本身：**1 RTT**

跨美国、用 TLS 1.3 的情况下是 3 × 70 = 210 ms，这时服务端一行代码都还没执行。如果是 TLS 1.2，再加 70 ms。

**发数据也要等。** 新连接受慢启动限制，第一个 RTT 只能发大约 10 个 MSS（initcwnd = 10，约 14 KB，见 RFC 6928），之后每个 RTT 翻一倍。一个 100 KB 的响应，在新连接上要 14 + 28 + 56 = 98 KB，还差一点，第 4 个 RTT 才能发完，跨美国就是 280 ms；在窗口早已涨大的热连接上，1 个 RTT 就够了。

所以复用连接一次省掉两笔钱：握手的 RTT，和窗口重新涨一遍的 RTT。

## TCP：可靠字节流的代价

### 三次握手：每一步在做什么

先记住一个前提：握手完全由内核完成，应用不参与。客户端的应用调 `connect()` 后就阻塞着等结果；服务端的应用只调过一次 `listen()`，之后用 `accept()` 从队列里取**已经握好手**的连接。

![TCP 三次握手时序图：SYN、SYN+ACK、ACK 三个包，以及两边的状态变化](/diagrams/tcp-handshake.svg)

1. **SYN**：客户端随机选一个初始序列号（ISN）`x`，发一个带 SYN 标志、不带数据的包，进入 `SYN_SENT`。意思是「我要连你，我这边的字节从 `x` 开始编号」。
2. **SYN+ACK**：服务端内核收到后，在**半连接队列**里记下这个连接，进入 `SYN_RCVD`。回一个包同时做两件事：用 `ack=x+1` 确认收到了客户端的 SYN（SYN 本身占一个序号，所以是 +1），再带上自己的 ISN `y`。
3. **ACK**：客户端收到后就算建好了，进入 `ESTABLISHED`，`connect()` 返回。它回 `ack=y+1` 确认服务端的 ISN。服务端收到这个 ACK 后也进入 `ESTABLISHED`，把连接从半连接队列挪到**全连接队列**，等应用 `accept()`。

第 3 步的 ACK 可以直接带上请求数据，所以客户端在 1 RTT 后就能开始发请求，这就是前面说「TCP 握手花 1 RTT」的来源。

**为什么是三次，不是两次？** 双方都要确认两件事：对方收到了我的 ISN，我也收到了对方的 ISN。第 1、2 步之后，客户端已经确认了，但服务端还不知道客户端有没有收到 `y`，第 3 步就是补上这一次确认。另一个原因是网络里可能滞留着很久以前的旧 SYN：如果两次就算建连，旧 SYN 一到服务端就会单方面建立连接、白占资源；三次握手下，客户端会发现这个 SYN+ACK 对不上自己发过的 SYN，回 RST 拒绝掉。

**丢包了会怎样？**

| 丢的是 | 结果 |
|---|---|
| (1) SYN | 客户端超时重发 SYN，间隔指数退避：1 s、2 s、4 s……（Linux `tcp_syn_retries` 默认 6 次，前后大约 2 分钟才放弃）。所以 `connect` 偶尔恰好慢 1 s 或 3 s，基本就是 SYN 丢了在重传。 |
| (2) SYN+ACK | 客户端会重发 SYN；服务端也会重发 SYN+ACK（`tcp_synack_retries` 默认 5 次）。 |
| (3) ACK | 客户端已经认为连上了，会直接发请求。请求包本身也带着 ACK，服务端收到它就能完成握手，所以通常没有影响。 |

### 四次挥手、TIME_WAIT 与 CLOSE_WAIT

TCP 是全双工的，可以看成两条方向相反的单行道，每个方向要单独关。一方发 FIN 只表示「我不会再发数据了」，它还能继续收。下面 A 是先调 `close()` 的一方（**主动关闭方**），可以是客户端，也可以是服务端：

![TCP 四次挥手时序图：FIN、ACK、FIN、ACK 四个包，B 的 CLOSE_WAIT 和 A 的 TIME_WAIT 分别覆盖的时间段](/diagrams/tcp-teardown.svg)

1. **A 发 FIN**：A 的应用调 `close()`（或 `shutdown(SHUT_WR)`），进入 `FIN_WAIT_1`。
2. **B 回 ACK**：B 的**内核**马上确认，B 进入 `CLOSE_WAIT`，B 的应用下一次 `read()` 会返回 0，也就是读到了 EOF。A 收到 ACK 后进入 `FIN_WAIT_2`。现在 A→B 这个方向已经关了，但 B→A 还开着，B 可以把没发完的数据发完。
3. **B 发 FIN**：B 的**应用**读到 EOF、处理完，自己调 `close()`，B 进入 `LAST_ACK`。
4. **A 回 ACK**：A 进入 `TIME_WAIT`，等 2 × MSL 后才真正释放。B 收到 ACK 后直接 `CLOSED`。

**为什么是四次，不像握手那样把中间两步合起来？** 握手时服务端的 SYN 和 ACK 都是内核发的，可以合在一个包里。挥手时，第 2 步的 ACK 是内核**立刻**回的，而第 3 步的 FIN 要等 B 的**应用**调 `close()`，内核不知道应用什么时候调，所以只能分开发。如果 B 的应用读到 EOF 后马上 `close()`，ACK 和 FIN 也会被合成一个包，抓包时经常只看到三个包。

这个流程里有两个状态在线上最常出问题：

- **TIME_WAIT**：出现在**主动关闭的一方**，持续 2 × MSL（Linux 上固定为 60 s）。它的作用一是保证最后一个 ACK 丢了之后还能重发（B 收不到 ACK 会重发 FIN，A 得还记得这个连接），二是让旧连接的迟到报文自然过期，不会串到用同一个四元组的新连接里。短连接打得很密的**客户端**（比如每个请求都新建连接去调下游的服务）会攒出几万个 TIME_WAIT，把本地端口（默认约 28000 个）耗光。对策按优先级是：连接池 > `net.ipv4.tcp_tw_reuse` > 让对端主动关闭。
- **CLOSE_WAIT**：出现在**被动关闭的一方**，就是上图第 2 步到第 3 步之间：内核已经替应用回了 ACK，但应用还没调 `close()`。正常情况下这段时间很短；CLOSE_WAIT 堆积几乎都是**应用层 bug**，比如连接泄漏、异常路径上没关 socket，内核参数救不了。

还有一种不走四次挥手的关闭：**RST**。一方直接发 RST，连接立刻作废，没有 TIME_WAIT。常见于往已经关掉的端口发包、`close()` 时接收缓冲区里还有没读的数据，或者设了 `SO_LINGER` 为 0。应用看到的就是 `connection reset by peer`。

### 拥塞控制：一次能发多少

**它要解决的问题**：发送方不知道路径中间最窄的那一段（瓶颈）能承受多少流量。发多了，路由器的队列会溢出、开始丢包，大家一起重传，网络更堵。所以发送方维护一个**拥塞窗口 cwnd**：在没收到 ACK 的情况下，最多能有多少字节在路上。发送速率大约是 `cwnd / RTT`。

经典算法（Reno）的 cwnd 变化分三段：

1. **慢启动**：新连接从 10 个 MSS（约 14 KB）起步，每过一个 RTT 翻一倍：14 KB → 28 KB → 56 KB……名字叫「慢」，其实是指数增长，「慢」是相对于一上来就全速发而言的。
2. **拥塞避免**：cwnd 涨到一个阈值（ssthresh）后，改成每个 RTT 只加 1 个 MSS，线性地、小心地试探上限。
3. **丢包时减半**：发现丢包，就认为网络堵了，cwnd 砍一半（ssthresh 也设成这个值），再回到线性增长。如果是严重到超时的丢包，cwnd 直接退回 1 个 MSS，重新慢启动。

画出来就是一条锯齿线：涨、涨、涨、丢包、砍半、再涨。**CUBIC** 是 Linux 现在的默认算法，思路一样（靠丢包判断拥塞），只是丢包后砍到 0.7 倍而不是一半，并且按三次函数恢复：离上次丢包的窗口远时涨得快，接近时放慢。这样在带宽大的链路上恢复得快得多。

**靠丢包判断拥塞有什么问题**：

- **丢包不一定是因为拥塞**：Wi-Fi、蜂窝网络这类链路会随机丢包，算法却把它当成拥塞，白白减速。
- **长肥管道（long fat network）恢复很慢**：长肥管道指带宽大、RTT 也大的链路，比如 1 Gbps、RTT 100 ms 的跨洋线路，要填满它，路上得同时有 1 Gbps × 0.1 s = 12.5 MB 的数据（这个乘积叫 BDP，带宽时延积）。Reno 丢一次包窗口减半，之后每个 RTT 只加 1 个 MSS（约 1.4 KB），涨回去要几千个 RTT，也就是好几分钟。
- **把路由器缓冲区灌满才会停**：要等到丢包才减速，意味着中间设备的缓冲区一直是满的，排队时延很高（bufferbloat）。

**BBR**（Google 提出，Linux 4.9 起可用）换了思路：不看丢包，而是直接测量两个量：瓶颈带宽（最近一段时间观察到的最大交付速率）和最小 RTT（没有排队时的 RTT）。然后按「瓶颈带宽」的速度匀速发，路上的数据量控制在「带宽 × 最小 RTT」左右，刚好填满管道、又不在缓冲区里排队。所以它在随机丢包的链路和长肥管道上都表现更好。代价是早期版本和 CUBIC 抢带宽时不够公平。开启方法是 `sysctl net.ipv4.tcp_congestion_control=bbr`。

**对后端开发来说**，拥塞控制是内核的事，你主要会在这几个地方感觉到它：

- 新连接受慢启动影响，大响应要好几个 RTT 才能发完，这又是一个复用连接的理由。
- Linux 默认 `tcp_slow_start_after_idle=1`：长连接空闲一会儿之后，cwnd 会被重置，下一次大响应又要从慢启动开始。长连接为主的服务端可以把它设成 0。
- 跨地域的大文件传输、视频这类业务可以考虑换 BBR。

### Nagle 与 delayed ACK：两个优化撞在一起

这两个机制单独看都是合理的优化，都是为了**少发包**：

- **Nagle 算法**（发送方）：如果还有已发出但没被 ACK 的数据，新写入的**小**数据（不满一个 MSS）先不发，攒着，等 ACK 回来或者攒够一个 MSS 再发。它最初是为 telnet 设计的：每敲一个字符就发一个包，1 字节数据配 40 字节头，太浪费。
- **delayed ACK**（接收方）：收到数据不马上回 ACK，等一会儿，希望自己有响应数据要发时，把 ACK 顺带捎上，或者攒两个包一起确认。Linux 上通常等 40 ms 左右，Windows 默认 200 ms。

**两个叠在一起就互相等**。典型场景是客户端把一个请求分两次 `write()`，先写 header，再写 body：

1. 第一次 `write(header)`：路上没有未确认的数据，立刻发出。
2. 第二次 `write(body)`：数据很小，而 header 还没被 ACK，**Nagle 把 body 扣住**，等 header 的 ACK。
3. 服务端收到 header，但请求还不完整，没法处理，也就没有响应可以捎带 ACK，于是 **delayed ACK 等满 40 ms** 才单独回 ACK。
4. 40 ms 后 ACK 到达，客户端这才把 body 发出去，服务端处理并响应。

结果就是每个请求都稳定多出 40 ms，CPU 和网络却都很空闲。修法：

1. 在发小包、要等回应的连接上设 **`TCP_NODELAY`**（关掉 Nagle），比如 RPC、Redis、数据库协议。Go 标准库和 gRPC 默认已经设了。
2. 应用层把一个请求攒成一次写入（自己拼好 buffer，或者用 `writev`），从源头上不产生「写-写-读」的模式。

### backlog：握手完成后在哪排队

这一节接着上面的握手流程讲，属于「少排队」：请求还没到应用，就可能先在内核里排上队。

#### backlog 是什么

backlog 就是 `listen()` 的第二个参数，一个整数，规定了「**握手已经完成、但应用还没 `accept()` 取走**」的连接最多能排多少个。这个词的英文本义是「积压」，所以平时也直接用 backlog 指这个排队的队列本身。

```python
sock.listen(128)   # 这个 128 就是 backlog
```

可以把它想成餐厅门口的等位区：

- **内核**是门口迎宾：客人来了，握手寒暄（三次握手），领到等位区坐下，全程不用叫服务员。
- **应用**是服务员：每调一次 `accept()`，就从等位区领一桌客人进去服务。
- **backlog** 是等位区的椅子数。

严格地说，服务端每个监听 socket 有两个队列，backlog 管的是第二个：

- **半连接队列**（SYN queue）：收到了 SYN、回了 SYN+ACK，还在等第 3 步 ACK 的连接，状态是 `SYN_RCVD`。
- **全连接队列**（accept queue）：三次握手已经完成、状态是 `ESTABLISHED`，但应用还没调 `accept()` 取走的连接。

实际生效的长度是 `min(backlog, net.core.somaxconn)`，所以只调应用的参数、不调系统上限，可能白调。`somaxconn` 在 Linux 5.4 之前默认只有 128，之后是 4096。平时会在这些地方碰到它：

| 位置 | 写法 |
|---|---|
| 自己写 socket | `listen(fd, 128)` |
| uvicorn | `--backlog`，默认 2048 |
| nginx | `listen 80 backlog=4096;`，Linux 上默认 511 |
| 系统上限 | `sysctl net.core.somaxconn` |

#### 满了会怎样

握手的第 3 步 ACK 到了，内核却没地方放这个连接。Linux 默认（`tcp_abort_on_overflow=0`）的做法是**直接丢掉这个 ACK**，假装没收到，过一会儿再重发 SYN+ACK，希望到时队列空出位置。这时客户端已经认为连接建好了，请求发出去却迟迟没有回应；新来的 SYN 也可能被丢，客户端只能等 1 s、3 s 后重传。换成餐厅的说法：等位区坐满了，迎宾对新来的客人假装没看见，客人以为自己排上了，其实没人知道他在等。

所以==表现是偶发的连接超时或者莫名多出 1 s 延迟，而服务端日志里什么都没有==，因为请求根本没到应用。排查方法：

- `ss -lnt`：对 LISTEN 状态的 socket，`Recv-Q` 是全连接队列当前的长度，`Send-Q` 是上限。`Recv-Q` 经常贴着 `Send-Q`，就是队列满了。
- `netstat -s | grep -i listen`：看 `times the listen queue of a socket overflowed` 这个计数有没有在涨。

#### 为什么调大 backlog 不管用

看到队列溢出，第一反应往往是把 backlog 调大。这只在一种情况下有用：**短暂的突发**。比如整点有一波流量，几秒后就回落，平均下来应用取得过来，多几把椅子正好让这波人等一等，不至于被丢掉。

如果是**持续**的「来得比取得快」，调大就没用，原因有三个：

1. **再大的队列也会满**。每秒来 1200 个连接、应用每秒只取 1000 个，队列每秒净增 200，backlog 从 128 调到 4096，只是从不到 1 秒满变成 20 秒满。
2. **排在后面的请求已经没意义了**。队列里的请求要等的时间 ≈ 队列长度 ÷ 取走的速度。4096 个连接、每秒取 1000 个，排在末尾的要等 4 秒；如果客户端超时是 3 秒，它早就放弃了，服务端过一会儿还是会把这个连接取出来处理，白干一场，还挤占了后面新请求的位置。
3. **把问题藏起来了**。队列小的时候，过载会很快表现为连接失败，客户端可以重试别的实例、告警也会响；队列大了，过载变成所有请求一起变慢，更难发现，也更难恢复。

所以 ==backlog 满了，说明应用取连接的速度跟不上，要修的是应用==：

- 别阻塞事件循环：async 代码里不要调同步的 HTTP 请求、不要跑 CPU 密集计算（见[并发模型](/stack/f-concurrency)）。
- 加 worker 或者扩实例，让每秒能取走的连接数上去。
- 真的扛不住时主动拒绝（返回 503、限流），而不是让请求在队列里慢慢超时（见[限流、熔断与重试](/stack/ds-resilience)）。

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

::: details 顺带一问：SYN flood 是什么，怎么防？
这是安全话题，不在本篇主线上，但常接在 backlog 后面被追问。

SYN flood 打的是**半连接队列**：攻击者伪造大量源 IP 发 SYN，却从不发第 3 步 ACK。每个 SYN 都在半连接队列里占一个位置，队列很快被占满，正常用户的 SYN 就进不来了。

防御是 **SYN cookies**（Linux 默认开启，队列溢出时生效）：收到 SYN 时不记任何状态，而是把连接信息（四元组的哈希、时间戳、MSS）编码进自己发出的 ISN `y`。正常客户端回 `ack=y+1` 时，服务端从中校验并还原连接；伪造的 SYN 没有后续 ACK，不占资源。代价是部分 TCP 选项会丢失。更大规模的 DDoS 一般在云厂商的清洗中心处理，见[安全](/stack/layer-7)。
:::

## 参考

- [RFC 9293: TCP](https://www.rfc-editor.org/rfc/rfc9293)、[RFC 6928: Increasing TCP's Initial Window](https://www.rfc-editor.org/rfc/rfc6928)
- [RFC 9438: CUBIC](https://www.rfc-editor.org/rfc/rfc9438)、[BBR: Congestion-Based Congestion Control](https://queue.acm.org/detail.cfm?id=3022184)（ACM Queue）
- Cloudflare, [SYN packet handling in the wild](https://blog.cloudflare.com/syn-packet-handling-in-the-wild/)：半连接队列、全连接队列和 SYN cookies 的实测讲解
- [RFC 8446: TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446)
- [RFC 9113: HTTP/2](https://www.rfc-editor.org/rfc/rfc9113)、[RFC 9114: HTTP/3](https://www.rfc-editor.org/rfc/rfc9114)、[RFC 9000: QUIC](https://www.rfc-editor.org/rfc/rfc9000)
- Ilya Grigorik, [High Performance Browser Networking](https://hpbn.co/)：讲延迟、TCP、TLS、HTTP/2 最好的一本书，免费在线读
- [AWS ALB idle timeout](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html#connection-idle-timeout)
- 实战代码：DocPilot `api/src/docpilot/ui_stream.py`（SSE 响应头）、`api/src/docpilot/retrieval/rerank.py`（每次调用都新建 client）
