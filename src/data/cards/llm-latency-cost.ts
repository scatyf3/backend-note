import type { Card } from '@lib/flashcards'

const R = '/ai/llm-latency-cost'

export const cards: Card[] = [
  {
    id: 'lat-prefill-decode',
    deck: 'ai',
    topic: 'prefill / decode',
    q: 'prefill 和 decode 的瓶颈分别是什么？为什么？',
    a: '- **prefill**：所有输入 token 一起**并行**算，本质是大矩阵乘，瓶颈是**算力**。FLOPs ≈ $2 \\times N_{params} \\times n_{input}$，TTFT 大致随输入长度线性增长。\n- **decode**：每一步只出一个 token，但要把**全部权重**（再加上 KV cache）从显存读一遍，算术强度很低，瓶颈是**显存带宽**。\n所以总延迟 ≈ TTFT + 输出 token 数 × TPOT。',
    ref: `${R}#为什么-prefill-和-decode-是两种完全不同的负载`,
  },
  {
    id: 'lat-decode-estimate',
    deck: 'ai',
    topic: '估算',
    q: '估算：70B 模型 bf16，单个请求在 H100（约 3.35 TB/s）上 decode 的速度上限。',
    a: '权重 = 70B × 2 字节 = **140 GB**。每生成一个 token 都要读一遍：\n$$140\\ \\text{GB} \\div 3.35\\ \\text{TB/s} \\approx 42\\ \\text{ms / token} \\approx 24\\ \\text{token/s}$$\n实际上一张 80 GB 卡放不下，2 卡张量并行带宽翻倍，约 **48 token/s**。\n供应商靠 **batching** 让同一次权重读取服务很多请求，所以你的速度还取决于他们当时的负载。',
    ref: `${R}#decode-一次只出一个-token-吃带宽`,
  },
  {
    id: 'lat-output-pricier',
    deck: 'ai',
    topic: '计价',
    q: '为什么 LLM API 的输出 token 通常比输入 token 贵 4–5 倍？',
    a: 'prefill 一次并行处理所有输入 token，是算力受限的矩阵乘，GPU 利用率高；decode 每出一个 token 都要读一遍全部权重，是**带宽受限**的，GPU 算力大量空转，只能靠 batching 摊薄。\n同样一个 token，**输出占用的 GPU 时间远多于输入**，所以定价更高。thinking token 也按输出计费。',
    ref: `${R}#decode-一次只出一个-token-吃带宽`,
  },
  {
    id: 'lat-agent-input-dominates',
    deck: 'ai',
    topic: '成本',
    q: '一个三步 agent 回答：累计输入 16.8K token、输出 600 token，价格为输入 4 美元 / 输出 20 美元每百万 token。成本是多少？哪部分是大头？这说明什么？',
    a: '输入：16.8K × 4 / 1M ≈ **0.067 美元**；输出：600 × 20 / 1M = **0.012 美元**；合计约 **0.08 美元**。\n输出单价是输入的 5 倍，但总成本里约 **85% 来自输入**，因为每一步都要重发全部历史。\n所以 agent 的优化顺序是：**prompt caching**（固定前缀打折）→ 控制工具返回大小 → 压缩旧的工具结果 → 模型分级 → 离线任务走 Batch API（五折）。',
    ref: `${R}#agent-场景-输入才是大头`,
  },
  {
    id: 'lat-metrics',
    deck: 'ai',
    topic: '指标',
    q: 'TTFT、TPOT、goodput 分别是什么？流式输出时用户最敏感的是哪个？',
    a: '- **TTFT**：发请求到收到第一个内容 token = 网络 + 排队 + prefill。\n- **TPOT / ITL**：两个输出 token 之间的平均间隔，取决于 decode 带宽和供应商的 batch 大小。\n- **goodput**：满足 SLO（比如 TTFT < 1 s 且 TPOT < 50 ms）的请求比例或吞吐。\n流式输出时用户最敏感的是 **TTFT**：看到第一个字就觉得有反应了。推理模型的 TTFT 还包括不可见的 thinking 时长。',
    ref: `${R}#延迟指标`,
  },
  {
    id: 'lat-ttft-levers',
    deck: 'ai',
    topic: 'TTFT',
    q: '要降低 TTFT，有哪些手段？',
    a: '1. **缩短 prompt**：精简 system prompt，少塞检索结果。\n2. **命中 prompt cache**：固定前缀放在最前面，并保持顺序稳定。\n3. **选离用户近的 region**。\n4. **用更小的模型**。\n5. 推理模型**调低 effort**，减少 thinking 时间（DocPilot 回答用 medium，judge 用 low）。',
    ref: `${R}#延迟指标`,
  },
  {
    id: 'lat-bench-pitfalls',
    deck: 'ai',
    topic: '压测',
    q: '压测 LLM 服务时，有哪些容易让延迟数字失真的坑？',
    a: '1. TTFT 要按**第一个内容 delta** 算，不能按响应头算。\n2. **测量工具本身**的问题：Windows 上 `localhost` 会先尝试 IPv6，每个新连接卡约 2 s，变成**假的 p99**，要用 `127.0.0.1`（LLMGateway 的教训）。\n3. **缓存污染**：重复 prompt 会命中缓存，要用真实 trace 或清空缓存，并记录命中率。\n4. 测单请求的效果（比如 prefix caching）要**串行**跑，避免排队干扰。\n5. 看 **p50 / p95 / p99**，不看平均值。',
    ref: `${R}#实战-怎么测才不自欺`,
  },
  {
    id: 'lat-missing-price',
    deck: 'ai',
    topic: '成本',
    q: 'DocPilot 的价格表里没有某个模型时，按 0 美元记成本并打一条告警。这个取舍的好处和风险是什么？',
    a: '**好处**：缺少价格不会让用户请求失败，计费是旁路功能，不应该影响主路径。\n**风险**：这部分成本被**静默低估**。比如切到新模型后，账单涨了而 trace 显示成本下降。\n所以要监控那条告警，或者在 CI 里检查配置用到的模型都在价格表里。排查「成本突然变化」时，也要先确认价格表是否覆盖了所有模型。',
    ref: `${R}#基本公式`,
  },
]
