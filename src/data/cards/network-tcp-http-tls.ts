import type { Card } from '@lib/flashcards'

const R = '/backend/network-tcp-http-tls'

export const cards: Card[] = [
  {
    id: 'net-new-conn-rtt',
    deck: 'backend',
    topic: 'TCP / TLS',
    q: '一个全新的 HTTPS 请求（TLS 1.3），在拿到第一个响应字节前要花几个 RTT？跨美国（RTT ≈ 70 ms）大约多久？',
    a: '1. TCP 三次握手：**1 RTT**\n2. TLS 1.3 握手：**1 RTT**（TLS 1.2 是 2 RTT）\n3. 请求 + 响应：**1 RTT**\n合计 **3 RTT ≈ 210 ms**，这时服务端代码还一行没跑。所以连接复用（keep-alive、连接池）把后续请求压到 1 RTT，是最便宜的优化。',
    ref: `${R}#为什么-延迟由-rtt-决定-而-rtt-降不下来`,
  },
  {
    id: 'net-time-wait-close-wait',
    deck: 'backend',
    topic: 'TCP',
    q: 'TIME_WAIT 和 CLOSE_WAIT 分别出现在哪一方？大量堆积各说明什么，怎么处理？',
    a: '**TIME_WAIT**：在**主动关闭方**，持续 2MSL（Linux 固定 60 s），用来重发最后的 ACK、让旧报文过期。客户端大量堆积说明在用短连接频繁打下游，可能耗尽本地端口 → 用**连接池** / `tcp_tw_reuse`。\n**CLOSE_WAIT**：在**被动关闭方**，收到 FIN 但应用没调 `close()`。堆积几乎都是**应用 bug**（连接泄漏），改内核参数没用，得查代码。',
    ref: `${R}#四次挥手、time-wait-与-close-wait`,
  },
  {
    id: 'net-hol-evolution',
    deck: 'backend',
    topic: 'HTTP',
    q: 'HTTP/1.1、HTTP/2、HTTP/3 的队头阻塞分别卡在哪一层？',
    a: '1. **HTTP/1.1**：应用层，一个连接上的请求只能排队，所以浏览器对每个域名开大约 6 个连接。\n2. **HTTP/2**：多路复用解决了应用层的队头阻塞，但卡在**TCP 层**：丢一个包，所有 stream 都要等重传。\n3. **HTTP/3**：QUIC over UDP，每个 stream 独立可靠传输，丢包只影响一个 stream，队头阻塞基本消除。',
    ref: `${R}#http-队头阻塞一路往下挪`,
  },
  {
    id: 'net-0rtt-replay',
    deck: 'backend',
    topic: 'TLS',
    q: '为什么 TLS 1.3 / QUIC 的 0-RTT 数据只能用来发幂等请求？',
    a: '0-RTT 数据用上一次会话的 PSK 加密，在握手完成**之前**就发出去，服务端没法区分它是正常请求还是攻击者截获后的**重放**。`POST /transfer` 被重放一次就扣两次钱。所以只允许 GET 这类幂等请求走 0-RTT，或者在应用层用**幂等 key** 去重。',
    ref: `${R}#http-队头阻塞一路往下挪`,
  },
  {
    id: 'net-tls13-1rtt',
    deck: 'backend',
    topic: 'TLS',
    q: 'TLS 1.3 是怎么把握手从 2 RTT 压到 1 RTT 的？',
    a: '1. **砍掉 RSA 密钥交换**，只保留 (EC)DHE，所以天然**前向保密**。\n2. 客户端在 ClientHello 里**猜**服务端会用的曲线，直接附上 key share，服务端一个来回就能算出会话密钥，不用先协商算法再交换密钥。\n顺带：**ALPN** 在同一次握手里协商 `h2`，不额外花 RTT。',
    ref: `${R}#tls-1-3-1-rtt-是怎么做到的`,
  },
  {
    id: 'net-nodelay',
    deck: 'backend',
    topic: 'TCP',
    q: '小包 RPC 出现稳定约 40 ms 的尾延迟，最可能的原因是什么？怎么修？',
    a: '**Nagle 算法 + delayed ACK** 叠加：发送方的 Nagle 要等前一个小包的 ACK 才发下一个，接收方的 delayed ACK 最多攒 40 ms 才回 ACK，两边互相等。\n修法：在交互式协议的 socket 上设 **`TCP_NODELAY`**（关掉 Nagle）。大多数 HTTP 客户端和 gRPC 默认已经设了。',
    ref: `${R}#拥塞控制与-nagle`,
  },
  {
    id: 'net-l4-l7-grpc',
    deck: 'backend',
    topic: '负载均衡',
    q: '为什么 gRPC 服务放在 L4 负载均衡后面，负载经常不均衡？',
    a: 'L4 按 TCP 连接转发，而 gRPC 跑在 **HTTP/2 长连接**上，一个连接承载大量请求。连接一旦建好，所有请求都**粘在同一个后端**上，新扩容的实例也分不到流量。\n解决：用 **L7 负载均衡**（按请求而不是按连接分发），或者做**客户端负载均衡**（客户端拿到后端列表，自己挑选）。',
    ref: `${R}#负载均衡-l4-和-l7`,
  },
  {
    id: 'net-llm-long-conn',
    deck: 'backend',
    topic: 'LLM 流式',
    q: 'LLM 流式响应上线后，用户反馈「要等全部生成完才一次性出现」或「长回答中途断开」。分别怀疑什么？',
    a: '1. **一次性出现**：中间的代理（nginx 等）在**缓冲**上游响应。DocPilot 的做法是在响应头里加 `x-accel-buffering: no`，再配上 `cache-control: no-cache`。\n2. **中途断开**：LB / 代理的 **idle timeout**（比如 AWS ALB 默认 60 s）。推理模型 thinking 时可能很久没有输出，要定期发**心跳**（SSE 注释行 `: ping`），或者调大超时。',
    ref: `${R}#ai-时代多出来的网络问题-连接变长了`,
  },
]
