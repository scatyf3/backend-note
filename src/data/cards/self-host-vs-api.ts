import type { Card } from '@lib/flashcards'

const R = '/ai/self-host-vs-api'

export const cards: Card[] = [
  {
    id: 'selfhost-when',
    deck: 'ai',
    topic: '自托管',
    q: '什么情况下自托管 LLM 推理比调用 API 更划算？',
    a: '1. **流量大且稳定**：GPU 利用率高，单位成本才能降下来；\n2. **任务窄**：分类、抽取、改写，开源小模型就够用；\n3. **长前缀大量重复**：自托管引擎的 prefix caching 让重复的长 prompt 几乎免费；\n4. **数据不能出域**（不过供应商的区域部署、企业协议有时也能满足）；\n5. **需要微调**；\n6. 对延迟要求严格、不想受供应商限流。\n否则，算上空闲时间和运维人力，**API 通常更便宜**。',
    ref: `${R}#什么时候自托管划算`,
  },
  {
    id: 'selfhost-cost-formula',
    deck: 'ai',
    topic: '算账',
    q: '怎么估算自托管模型每百万 token 的成本？为什么利用率是关键？',
    a: '$$\\frac{\\text{GPU 时价}}{\\text{每秒 token 数} \\times \\text{利用率} \\times 3600} \\times 10^6$$\n假设：GPU 每小时 2 美元、开批处理后每秒 2000 token、利用率 50% → 约 **0.56 美元 / 百万 token**，可能比小模型的 API（0.10–0.40）还贵，而且没算人力。\n**利用率是关键**：供应商把大量客户的请求混在一起，GPU 几乎一直满载；自己的 GPU 夜里和周末大多空闲，但**空闲的 GPU 照样按小时收费**。',
    ref: `${R}#算账-每百万-token-的成本`,
  },
  {
    id: 'selfhost-hidden-costs',
    deck: 'ai',
    topic: '算账',
    q: '自托管推理有哪些容易被低估的成本？',
    a: '1. **运维人力**：驱动、CUDA、推理引擎升级、监控、值班；\n2. **为峰值预留的空闲容量**：GPU 扩容慢，加载一个模型要几分钟，必须提前备好容量；\n3. **质量差距**：开源小模型在复杂任务上通常不如最强的商业模型，要靠更好的 prompt、微调、检索来弥补；\n4. **工程投入**：批处理参数、量化、上下文长度、开源模型的工具调用格式都要自己调。',
    ref: `${R}#被低估的成本`,
  },
  {
    id: 'selfhost-zero-price',
    deck: 'ai',
    topic: '算账',
    q: 'LLMGateway 的价格表里，自托管的 Qwen 模型价格是 0。为什么不应该一直这样？',
    a: '价格设成 0，成本仪表盘上自托管的那一路看起来就是**免费**的，和 API 的成本对比、按成本路由的决策都会被**扭曲**。\n配置里的注释也写明了：要计入成本，就**设成摊销后的 GPU 成本**。\n自托管不是免费的，只是付费方式从**按 token** 变成了**按 GPU 小时**。',
    ref: `${R}#公平地比较-给自托管的模型标上价格`,
  },
  {
    id: 'selfhost-vllm',
    deck: 'ai',
    topic: '推理引擎',
    q: 'vLLM 这类推理引擎提供哪些关键能力？LLMGateway 的启动脚本调了哪些参数？',
    a: '**能力**：continuous batching（GPU 持续满载）、**PagedAttention**（按页管理 KV cache，容纳更多并发序列）、**prefix caching**、量化（int8 / int4）、张量并行、OpenAI 兼容接口。\n**参数**（`deploy/vllm-slurm.sh`）：\n- `--max-model-len 8192`：限制单个序列的上下文和 KV cache；\n- `--gpu-memory-utilization 0.85`：权重加 KV cache 最多占 85% 显存；\n- `--enable-auto-tool-choice --tool-call-parser hermes`：开源模型的工具调用要指定解析器，可靠性要用 eval 验证；\n- prefix caching 开关，用于对照实验。',
    ref: `${R}#自托管的技术栈`,
  },
  {
    id: 'selfhost-hybrid',
    deck: 'ai',
    topic: '混合部署',
    q: 'LLMGateway 是怎么把自托管的 vLLM 和 API 组合起来用的？',
    a: '1. **自托管排在链的最前面，API 作为 fallback**：`cheap` 别名是 vLLM → claude-haiku → mock。集群作业结束或 GPU 出问题，请求自动转到 API，应用感知不到；\n2. **规则把最合适的流量导过去**：超过 **3000 token** 的 `fast` / `cheap` 请求路由到 `local`（vLLM）。长 prompt 的成本主要在 prefill，**prefix caching** 让重复的长前缀几乎免费；\n3. vLLM **默认关闭**（`VLLM_ENABLED=false`），没有 GPU 时系统照样能跑。\n当前的部署（单张 GPU、Slurm 作业 4 小时、SSH 隧道）只是实验环境，没有高可用。',
    ref: `${R}#网关里的混合部署`,
  },
  {
    id: 'selfhost-prefix-experiment',
    deck: 'ai',
    topic: '实验',
    q: '怎么设计一个实验来验证 prefix caching 的收益？LLMGateway 的实验有哪些细节？',
    a: '**两组对照**：\n- **共享组**：所有请求用同一个很长的 system prompt，只有问题不同；\n- **独占组**：在 system prompt 的**开头**插入随机字符串，前缀无法复用（放在末尾的话，前面的长 prompt 仍是共享前缀，照样能命中）。\n两组 **TTFT 之差**就是收益。\n**细节**：请求**串行**发送，排除排队影响；经过网关时带 `x-gateway-cache: skip` 绕过网关缓存；可以再用关闭 prefix caching 的服务器跑一遍，确认这时两组结果一样。',
    ref: `${R}#怎么验证-prefix-caching-的收益`,
  },
  {
    id: 'selfhost-decision',
    deck: 'ai',
    topic: '决策',
    q: '一个团队考虑把部分 LLM 流量迁到自托管，合理的决策步骤是什么？',
    a: '1. **先用 API 把产品做出来**，用 eval 确定需要的质量水平；\n2. 用 **trace** 统计真实流量：量多大、多稳定、哪些任务占大头、前缀重复率多高；\n3. 按**真实利用率**估算自托管的单位成本，并且**算上人力**；\n4. 只把最适合的流量（量大、任务窄、前缀重复多）在**网关**上单独路由过去，API 作为 fallback；\n5. 给自托管模型标上**摊销后的价格**，用同一套 eval 和成本指标持续对比。',
    ref: `${R}#决策清单`,
  },
]
