import type { Card } from '@lib/flashcards'

const R = '/ai/tokens-context-window'

export const cards: Card[] = [
  {
    id: 'tok-why-subword',
    deck: 'ai',
    topic: 'tokenizer',
    q: 'LLM 为什么用子词（BPE）切分，而不是按字符或按单词？',
    a: '1. **按字符**：序列太长，attention 是 $O(n^2)$，计算和显存都扛不住。\n2. **按单词**：词表爆炸，新词、拼写错误、代码标识符都会变成 OOV。\n3. **子词**：折中。BPE 从字节开始，反复合并最常见的相邻对，常见词是一个 token，罕见词拆成几块。**byte-level BPE** 以字节为底层单元，任何输入都能编码，没有 OOV。',
    ref: `${R}#为什么是子词`,
  },
  {
    id: 'tok-estimate',
    deck: 'ai',
    topic: '估算',
    q: '1000 个英文单词大约是多少 token？为什么同样的估算不能直接用在中文上？',
    a: '英文：1 token ≈ 4 字符 ≈ 0.75 词，所以 1000 词 ≈ **1333 token**。\n中文：一个汉字在不同 tokenizer 下约 **0.5–1.5 个 token**，差别很大，要用目标模型的 tokenizer 实测。tokenizer 的训练语料以英文为主，非英语往往更费 token，意味着更贵、上下文更挤、延迟更长。\n**计费以 API 返回的 usage 为准。**',
    ref: `${R}#估算口径`,
  },
  {
    id: 'tok-chunker-cjk',
    deck: 'ai',
    topic: '切分',
    q: 'DocPilot 的切分器用 `len(text.split()) / 0.75` 近似 token 数。上传一份中文文档会出什么问题？',
    a: '中文**没有空格**，一整段 `split()` 后只算 1 个「词」，所以 token 数被**严重低估**：\n1. 一个标称 500 token 的 chunk 实际可能装进几百段中文、几万个 token；\n2. 超过 embedding 模型的输入上限（`text-embedding-3-small` 是 8191 token）时，上传直接报错；\n3. 就算没超限，巨大 chunk 的向量也只是全文的模糊平均，检索质量很差。\n修法：用真实 tokenizer 计数，或者对 CJK 文本按字符数估算。',
    ref: `${R}#实战-按空格数词-在中文上会坏掉`,
  },
  {
    id: 'tok-window-budget',
    deck: 'ai',
    topic: '上下文窗口',
    q: '一次 LLM 调用的上下文窗口要装下哪些东西？哪两项最容易被忽略？',
    a: 'system prompt + **工具定义（JSON Schema）** + 历史消息 + 检索到的文档 + 本轮问题 + **预留的输出（max_tokens）**。输入和输出**共用**这个窗口。\n最容易忽略：\n1. **工具定义**：每次调用都要把所有工具的 schema 发一遍，工具多时有几千 token；\n2. **输出预留**：输出被截断时 stop_reason 是 `max_tokens`，DocPilot 遇到这种情况不会执行被截断的 tool call，因为参数可能只写了一半。',
    ref: `${R}#上下文窗口-输入和输出共用`,
  },
  {
    id: 'tok-agent-quadratic',
    deck: 'ai',
    topic: 'agent 成本',
    q: '一个 agent 跑了 6 步，第 1 步用 read_doc 读进来 20K token 的文档。光这份文档在整个任务里大约要付多少输入 token？为什么？',
    a: '每一步调用都要**重发完整历史**。第 1 步读进来的 20K token，后面 5 步每一步都要再发一次：$5 \\times 20\\text{K} = 100\\text{K}$ 输入 token。\n所以 agent 的总输入 token = 每一步上下文长度之和，随步数**近似平方增长**。\n缓解：**prompt caching**（重复前缀打折）、压缩或丢弃旧的工具结果、限制单次工具返回的大小（DocPilot 的 read_doc 最多返回 40 个 chunk）。',
    ref: `${R}#agent-循环的-token-是累加的`,
  },
  {
    id: 'tok-kv-bytes',
    deck: 'ai',
    topic: 'KV cache',
    q: '估算 Llama 3 70B（80 层、8 个 KV head、head_dim 128、bf16）每个 token 的 KV cache 大小，以及 128K 上下文需要多少显存。',
    a: '$$2 \\times n_{layers} \\times n_{kv} \\times d_{head} \\times \\text{bytes} = 2 \\times 80 \\times 8 \\times 128 \\times 2 = 327{,}680\\ \\text{B} \\approx 320\\ \\text{KB}$$\n公式里的 2 是 K 和 V 各存一份。\n128K token × 320 KB ≈ **40 GB**，单个序列就占半张 80 GB 的 H100。这是长上下文**贵、并发低**的物理原因。',
    ref: `${R}#约束-1-kv-cache-显存`,
  },
  {
    id: 'tok-long-window-not-strategy',
    deck: 'ai',
    topic: '上下文窗口',
    q: '模型支持 1M 上下文了，为什么还不直接把整个知识库塞进 prompt，而要做 RAG？',
    a: '1. **贵**：按输入 token 计费，每次调用都要付全量。\n2. **慢**：prefill 的 attention 是 $O(n^2)$，TTFT 变长。\n3. **效果差**：**lost in the middle**（中间位置的信息容易被忽略），无关内容越多越容易分心（context rot）。\n4. KV cache 显存线性增长，供应商的并发和限额也更紧。\n长窗口是**上限**，不是策略。检索 + 精选上下文通常更便宜、更快，效果也更好。',
    ref: `${R}#约束-3-训练长度和「用得好不好」`,
  },
  {
    id: 'tok-gateway-estimate',
    deck: 'ai',
    topic: '限流',
    q: 'LLM 网关做 TPM 限流时，输入 token 和输出 token 分别怎么处理？',
    a: '**输入**：请求发出前用约 4 字符 / token **粗估**并扣额度。只是跟阈值比较，不值得为每家供应商维护 tokenizer。\n**输出**：请求时是未知的，LLMGateway 在响应结束后按**真实 usage 补扣**（post-paid），允许令牌桶暂时变成负数。\n**计费**则用供应商返回的 usage。流式请求向上游要 `include_usage`，客户端没要求的话再把 usage 块藏起来。',
    ref: `${R}#估算口径`,
  },
]
