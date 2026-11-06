---
title: 缓存
---

# 缓存

这一格用空间换时间：把慢的读放到快的地方，命中率从 90% 提到 99%，回源流量就降到十分之一。最常用的 cache-aside 模式是读时回源写回、写时先更新 DB 再删缓存；剩下的竞态窗口靠 TTL、延迟双删或 CDC 失效兜底，缓存本质上是最终一致的。要防的三大问题：穿透（空值缓存、布隆过滤器）、击穿（single-flight、逻辑过期）、雪崩（TTL 抖动、高可用、源头降级）。

- **删缓存而不是更新缓存**：避免并发写入的顺序问题，也是懒加载。
- **只缓存成功的结果**：LLMGateway 只在流完整结束、状态 200 时写缓存，写入放在响应发出之后。
- **LLM 场景有四层缓存**：provider 的 prompt caching、exact cache、语义缓存、embedding 缓存，判断「相同」的标准各不一样。

笔记：[缓存：模式、失效与三大问题](/backend/caching)

**延伸阅读**：[Scaling Memcache at Facebook](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala)、[AWS: Caching Best Practices](https://aws.amazon.com/caching/best-practices/)
