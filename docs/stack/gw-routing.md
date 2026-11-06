---
title: LLM 网关
---

# LLM 网关

LLM 网关位于应用和多家供应商之间：OpenAI 兼容的统一 API，别名（有序的 fallback 链）加规则加等级的路由，只对可重试错误做 fallback，流式请求只在首字节之前 fallback，按 key 的 RPM + TPM 令牌桶（输出 token 事后结算），预算耗尽返回 402，exact 和语义缓存，以及每个请求的后端、成本、开销等计量信息。它把韧性模式套用到 LLM 这种慢、贵、会限流的依赖上，代价是多一跳延迟和一个需要高可用的关键组件。

- **规则路由**：超过 3000 token 的 `fast` / `cheap` 请求改走本地 vLLM，吃 prefix caching 的收益；`smart` / `best` 不擅自降级。
- **响应头即计量**：`x-gateway-route`、`x-gateway-cache`、`x-gateway-overhead-ms` 等，网关要证明自己的开销值得。
- **还缺的部分**：熔断器、感知健康状况的路由、Redis `TIME`、Cluster 的 hash tag、预算硬上限。

笔记：[LLM 网关：路由、fallback、限流与计量](/ai/llm-gateway)

**延伸阅读**：[LiteLLM Proxy](https://docs.litellm.ai/docs/simple_proxy)、[OpenAI: Rate limits](https://platform.openai.com/docs/guides/rate-limits)
