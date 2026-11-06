---
title: 灰度与 feature flag
---

# 灰度与 feature flag

部署（代码到达生产）和发布（用户看到新行为）应该分开，渐进式发布就是用来控制爆炸半径的。金丝雀发布小比例放量，和同期的基线组对比指标，异常自动回滚；蓝绿部署瞬间切换、瞬间回滚，代价是两倍资源和兼容两个版本的数据库；feature flag 把新行为变成运行时开关，按稳定的哈希分桶放量；影子流量用真实请求验证新版本，但不返回结果。回滚要快且演练过，破坏性的数据迁移会让回滚失效。

- **flag 是技术债**：发布开关和实验开关用完就删；flag 服务不可用时要有安全的默认值。
- **模型和 prompt 也是发布**：LLMGateway 的别名是天然的模型切换点，加上权重就能按比例灰度。
- **DocPilot 支持请求级别的 `retrieval.mode` / `reranker` 覆盖**，本身就是一种实验开关。

笔记：[灰度发布与 feature flag](/backend/progressive-delivery)

**延伸阅读**：[Feature Toggles](https://martinfowler.com/articles/feature-toggles.html)、[SRE Workbook: Canarying Releases](https://sre.google/workbook/canarying-releases/)
