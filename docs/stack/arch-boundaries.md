---
title: 服务边界
---

# 服务边界

单体还是微服务，是组织和演进的选择，而不只是技术选择。微服务用独立部署、独立扩展、故障隔离和团队自治，换来了网络延迟、部分失败、跨服务一致性、运维和调试的成本；最坏的结果是分布式单体：必须一起部署，还共享数据库。默认从模块化单体开始，按业务能力划分清楚的模块，每个模块独占自己的数据；等扩展特征、发布节奏、团队、安全要求真的分化了再拆，迁移时用绞杀者模式逐步替换。

- **DocPilot 是模块化单体**：ingest / retrieval / agent / llm / routes 边界清楚，共享一个 Postgres，入库是本地事务。
- **LLMGateway 单独成服务**：服务多个应用、持有供应商密钥、无状态独立扩展，边界是 OpenAI 兼容协议。
- **硬件差异是最自然的边界**：GPU 上的 vLLM 和 CPU 上的应用分开部署。

笔记：[服务边界：单体、微服务与模块化单体](/backend/service-boundaries)

**延伸阅读**：[MonolithFirst](https://martinfowler.com/bliki/MonolithFirst.html)、[Microservice Trade-Offs](https://martinfowler.com/articles/microservice-trade-offs.html)
