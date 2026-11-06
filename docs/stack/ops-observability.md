---
title: 可观测性
---

# 可观测性

可观测性是只靠系统对外输出的信号，就能回答内部发生了什么。指标聚合、便宜，适合趋势和告警；日志记录离散事件的细节；追踪还原一个请求的因果链；三者用 trace id 关联。延迟看直方图和分位数（分位数不能直接平均），选指标用 RED（服务）和 USE（资源），告警基于 SLO 的错误预算燃烧速率，针对症状而不是原因。

- **标签必须低基数**：LLMGateway 用 API key id 而不是用户、模型名来自配置，用户 id 这类信息放进日志和追踪。
- **分桶要按业务设**：LLM 请求延迟分桶到 64 秒，网关开销分桶到亚毫秒。
- **LLM 日志别写 prompt 原文**：LLMGateway 的语义缓存命中日志只记 prompt 的哈希和相似度。

笔记：[可观测性：指标、日志、追踪与 SLO](/backend/observability)

**延伸阅读**：[SRE Workbook: Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)、[Prometheus: Histograms](https://prometheus.io/docs/practices/histograms/)
