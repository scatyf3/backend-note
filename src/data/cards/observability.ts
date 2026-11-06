import type { Card } from '@lib/flashcards'

const R = '/backend/observability'

export const cards: Card[] = [
  {
    id: 'obs-three-pillars',
    deck: 'backend',
    topic: '可观测性',
    q: '指标、日志、追踪分别适合回答什么问题？举一个三者配合排查的例子。',
    a: '- **指标**：聚合的数字，便宜，看趋势、做告警（是不是出事了、影响多大、从什么时候开始）。\n- **追踪**：一个请求的因果链，定位**慢在哪一步**。\n- **日志**：离散事件的细节，看那一次**具体发生了什么**。\n例子：指标显示 p99 从 3 秒涨到 40 秒、只有走 Anthropic 的请求变慢 → 追踪显示 38 秒花在等第一个后端超时再 fallback → 日志里看到超时的错误详情。三者用 **trace id** 关联。',
    ref: `${R}#为什么需要三种信号`,
  },
  {
    id: 'obs-histogram',
    deck: 'backend',
    topic: '指标',
    q: '为什么延迟要用直方图看分位数，而不是平均值？多台机器的 p99 能直接平均吗？',
    a: '**平均值掩盖长尾**：99 个 100 毫秒加 1 个 30 秒，平均 400 毫秒，看起来正常，但 1% 的用户等了 30 秒。要看 **p50 / p95 / p99**。\n**分位数不能求平均**：要用直方图，各实例的**分桶计数直接相加**，再从合并后的直方图算分位数（Prometheus 的 `histogram_quantile`）。\n**分桶按业务设**：LLMGateway 的请求延迟和 TTFT 分桶到 **64 秒**，网关开销分桶到**亚毫秒**。',
    ref: `${R}#为什么延迟要用直方图-而不是平均值`,
  },
  {
    id: 'obs-red-use',
    deck: 'backend',
    topic: '指标',
    q: '什么是 RED 方法和 USE 方法？分别用在哪？',
    a: '- **RED**（面向**服务**）：**R**ate 请求速率、**E**rrors 错误率、**D**uration 延迟分布。每个服务和接口都应该有。\n- **USE**（面向**资源**）：**U**tilization 使用率、**S**aturation 饱和度（排队长度）、**E**rrors。用于 CPU、内存、连接池、队列。\n服务层用 RED 发现症状，再用 USE 查资源层的原因。LLMGateway 的指标基本就是 RED 加上 token、成本、缓存、fallback 这些 LLM 特有的维度。',
    ref: `${R}#选哪些指标-red-和-use`,
  },
  {
    id: 'obs-cardinality',
    deck: 'backend',
    topic: '指标',
    q: '什么是指标的高基数问题？LLMGateway 的 `metrics.py` 是怎么避免的？',
    a: '时序数据库里**每种标签值组合都是一条独立的序列**。把用户 id、请求 id、URL 原文这种取值无限的字段做标签，序列数会爆炸，存储和查询都会崩溃。\nLLMGateway 的原则：**标签低基数**，用 **API key 的 id 而不是用户**，后端和模型来自**配置**而不是自由文本；还调用了 `disable_created_metrics()` 去掉默认的 `_created` 序列，它们会让抓取量翻倍。\n高基数信息放进**日志和追踪**。',
    ref: `${R}#基数-最容易踩的坑`,
  },
  {
    id: 'obs-structured-logs',
    deck: 'backend',
    topic: '日志',
    q: '好的日志应该满足哪些要求？LLM 应用的日志有什么特别要注意的？',
    a: '1. **结构化**（JSON），能按字段搜索和聚合；\n2. 每行带 **trace id / request id**，能把一个请求的日志串起来；\n3. 分级，高频成功请求可以采样，错误全量记录；\n4. **不记录敏感数据**。\nLLM 应用：prompt 和回答里可能有个人信息和机密，默认不要写原文。LLMGateway 的语义缓存命中日志只记相似度、阈值和两边 prompt 的 **sha256 前缀**，既能审计误命中，又不泄露用户内容。',
    ref: `${R}#日志`,
  },
  {
    id: 'obs-tracing',
    deck: 'backend',
    topic: '追踪',
    q: '分布式追踪是怎么把多个服务的调用串起来的？头部采样和尾部采样有什么区别？',
    a: '一个 trace 由多个 span 组成。调用下游时，在请求头（W3C **`traceparent`**）里带上 trace id 和父 span id，下游把自己的 span 挂到同一棵树上；跨消息队列时放进消息元数据。OpenTelemetry 是事实标准。\n- **头部采样**：请求开始时按比例决定，简单，但可能**漏掉罕见的错误**；\n- **尾部采样**：请求结束后再决定，能保留**所有错误和慢请求**，但要先缓冲 span，成本更高。',
    ref: `${R}#分布式追踪`,
  },
  {
    id: 'obs-slo-burn',
    deck: 'backend',
    topic: 'SLO',
    q: 'SLI、SLO、错误预算分别是什么？告警应该怎么设计？',
    a: '- **SLI**：衡量指标，比如「成功且 TTFT < 2 秒的请求占比」；\n- **SLO**：目标，比如 30 天内 ≥ 99.5%；\n- **错误预算**：1 − SLO = 0.5%。预算充足就放心发布，快耗尽就冻结发布。\n**告警**：针对用户能感知的**症状**，而不是 CPU 这类原因；按错误预算的**燃烧速率**告警（比如 1 小时烧掉月度预算的 2% 就呼叫），同时用**长短两个窗口**；每条告警都应该需要人立即处理。',
    ref: `${R}#slo-与告警`,
  },
  {
    id: 'obs-llm-signals',
    deck: 'backend',
    topic: 'LLM',
    q: '除了传统的 RED 指标，LLM 应用还要额外关注哪些信号？DocPilot 的 `traces` 表和分布式追踪是什么关系？',
    a: '**额外信号**：按供应商 / 模型统计的 **TTFT 和输出速度**；按应用 / 用户 / 功能统计的 **token 和成本**；**缓存命中率**和省下的钱；**fallback 次数和原因**；质量信号（拒答率、点踩率、引用校验失败率）。\n**DocPilot 的 `traces` 表**为每一轮回答记录检索到的 chunk、工具调用、token、延迟、成本，是**业务级的 LLM trace**，回答「这个回答是怎么来的」；分布式追踪回答「慢在哪个服务」。两者互补。',
    ref: `${R}#llm-应用要额外关注的信号`,
  },
]
