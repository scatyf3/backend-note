---
title: 网络：TCP / HTTP / TLS
---

# 网络：TCP / HTTP / TLS

网络这一格解决的是「请求怎么可靠、安全、尽量快地到达服务」。核心约束是 RTT 降不下来：新的 HTTPS 连接在发出请求前要花 TCP 1 RTT + TLS 1.3 的 1 RTT，跨洋时就是几百毫秒。所以工程上的主线是**复用连接**（keep-alive、连接池）、**减少握手**（TLS 1.3、QUIC），以及**把队头阻塞往下挪**（HTTP/1.1 → 2 → 3）。代价是长连接带来的状态管理问题：TIME_WAIT、LB 粘性、代理超时。

- **TIME_WAIT 在主动关闭方，CLOSE_WAIT 堆积是应用 bug**：前者用连接池解决，后者要查代码里哪里没 close。
- **HTTP/2 解决应用层队头阻塞，HTTP/3（QUIC）解决传输层队头阻塞**；0-RTT 能被重放，只能发幂等请求。
- **LLM 流式响应让连接变长**：要处理代理缓冲（`x-accel-buffering: no`）和 idle timeout。

笔记：[网络：TCP / HTTP / TLS](/backend/network-tcp-http-tls)

**延伸阅读**：[High Performance Browser Networking](https://hpbn.co/)、[RFC 8446 (TLS 1.3)](https://www.rfc-editor.org/rfc/rfc8446)
