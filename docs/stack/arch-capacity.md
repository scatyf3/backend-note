---
title: 容量估算与高并发设计
---

# 容量估算与高并发设计

容量估算把需求（日活、每人请求数、峰值系数、数据保留期）换算成资源（QPS、并发、存储、带宽、实例数），关键公式是 Little's Law：并发 = 吞吐 × 平均耗时。估算的目的是找到瓶颈在哪一层、差几个数量级，而不是算准。高并发的手段按先简单后复杂排：无状态水平扩展、缓存、读写分离、异步削峰、CDN、分片，全程配合限流和降级；每一步都要用压测验证。

- **连接数是隐藏的天花板**：PostgreSQL 默认 100 个连接，DocPilot 每个实例 10 个，扩到 10 个实例就满了。
- **LLM 应用多两个维度**：并发长连接（每秒 50 个对话 × 20 秒 = 1000 个流）和 token 吞吐（约每分钟 5200 万 token，远超单个 key 的限额）。
- **LLMGateway 的压测**：阶梯加压、中途切断后端、请求里标注已知的重复比例，测出的命中率可以核对。

笔记：[容量估算与高并发设计](/backend/capacity-estimation)

**延伸阅读**：[Latency Numbers Every Programmer Should Know](https://gist.github.com/jboner/2841832)、[Locust](https://docs.locust.io/)
