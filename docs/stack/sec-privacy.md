---
title: 数据隐私与 PII
---

# 数据隐私与 PII

隐私工程的核心是少收集、知道数据在哪、能删干净。PII 不只是姓名和证件号，准标识符的组合同样能识别出个人；假名化的数据仍然是个人数据，邮箱做哈希也不算匿名化（要用带密钥的 HMAC）。手段包括最短保留期、信封加密、最小权限加审计，以及覆盖所有副本的删除（备份可以用 crypto-shredding）。LLM 带来三条新的数据外流路径：发给模型供应商，被复制进日志、trace、缓存和向量索引，被模型复述给其他用户。

- **DocPilot 删除文档**：chunk 和向量级联删除，trace 只存 id；但历史回答、网关缓存（1 小时 TTL）和供应商那边删不到。
- **embedding 也是个人数据**：vec2text 能相当程度地还原原文。
- **LLMGateway 的语义缓存命名空间不含租户**，多租户部署时可能把一个租户的回答给另一个租户。

笔记：[数据隐私与 PII](/backend/privacy-pii)

**延伸阅读**：[GDPR 第 17 条](https://gdpr-info.eu/art-17-gdpr/)、[Text Embeddings Reveal (Almost) As Much As Text](https://arxiv.org/abs/2310.06816)
