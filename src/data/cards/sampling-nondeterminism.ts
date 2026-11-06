import type { Card } from '@lib/flashcards'

const R = '/ai/sampling-nondeterminism'

export const cards: Card[] = [
  {
    id: 'samp-params',
    deck: 'ai',
    topic: '采样参数',
    q: 'temperature、top-k、top-p 分别控制什么？抽取 / 代码类任务和创意写作分别怎么设？',
    a: '- **temperature**：缩放 logits，$p_i \\propto \\exp(z_i/T)$。T 越低分布越尖，$T \\to 0$ 就是 greedy。\n- **top-k**：只在概率最高的 k 个 token 里抽。\n- **top-p（nucleus）**：只在累计概率达到 p 的最小集合里抽，截断位置随分布形状自适应。\n抽取、分类、代码、结构化输出用**低温度**（0–0.3）；创意写作用更高的温度。注意：部分新的推理模型已经不接受这些参数。',
    ref: `${R}#为什么-生成就是一步一步采样`,
  },
  {
    id: 'samp-t0-nondeterministic',
    deck: 'ai',
    topic: '非确定性',
    q: '为什么 temperature = 0 时，同一个请求发两次还可能得到不同的回答？',
    a: '主要原因是推理服务缺少**batch 不变性**：你的请求和别人的拼在一个 batch 里，batch 大小会改变 kernel 的归约切分方式，而**浮点加法不满足结合律**，logits 会有微小差异。两个候选 token 很接近时 argmax 被翻转，后面整个序列就分岔了。\n其他原因：MoE 的专家容量、供应商的版本 / 量化 / 硬件变化（`system_fingerprint` 会变）。\n结论：**不要依赖同输入同输出**，要复现就把实际输出记下来。',
    ref: `${R}#temperature-0-为什么还是不确定`,
  },
  {
    id: 'samp-cache-t0',
    deck: 'ai',
    topic: '缓存',
    q: 'LLMGateway 的 exact cache 为什么默认只缓存 temperature = 0、n = 1 的请求？',
    a: 'temperature > 0 的调用方要的是**随机样本**，缓存一次结果，等于把这一次抽样永久地返回给所有后来的人，破坏了调用方要的多样性。`n > 1` 要的是多个不同的样本，也不能缓存。\ntemperature = 0 的请求本来就期望确定的结果，缓存不改变语义。\n客户端可以用 `x-gateway-cache: allow` / `skip` 显式覆盖默认行为。',
    ref: `${R}#_1-缓存会冻结一次随机样本`,
  },
  {
    id: 'samp-retry-not-same',
    deck: 'ai',
    topic: '重试',
    q: '传统 API 的重试假设下游幂等。LLM 调用的重试有什么不同？流式请求要注意什么？',
    a: 'LLM 的重试拿到的是**另一个样本**，不是同一个结果再来一次。\n流式请求更麻烦：用户已经看到前半段了，这时换后端重试，会把**两次不同的生成拼成一个回答**。所以 LLMGateway 规定**流式请求只在首字节之前 fallback**，开始输出之后的失败只发一个 SSE `error` 事件，不再重试。',
    ref: `${R}#_2-重试不是「同一个结果再来一次」`,
  },
  {
    id: 'samp-testing',
    deck: 'ai',
    topic: '测试',
    q: 'LLM 的输出不确定，测试该怎么分层写？',
    a: '1. **单元测试**用脚本化的假模型（DocPilot 的 `LLM_PROVIDER=fake`），测 agent 循环、工具调度、流式编码这些确定性的代码，不需要 key。\n2. **集成测试**断言**性质**：JSON schema 合法、必填字段齐全、引用的 id 都存在。\n3. **质量评估**用固定数据集跑 eval：确定性检查（被引用的 chunk 里是否包含标准答案的原文）加上 LLM-as-judge，看分布和趋势，不看单次结果。',
    ref: `${R}#_3-测试要从断言字符串改成断言性质`,
  },
  {
    id: 'samp-hallucination-why',
    deck: 'ai',
    topic: '幻觉',
    q: 'LLM 为什么会产生幻觉？列出至少三个来源。',
    a: '1. **训练目标**是预测下一个 token，学到的是语言统计规律，不是可查询的事实库。\n2. **知识缺失还硬答**：训练数据里没有，或者超过了知识截止日期。\n3. **评估在鼓励猜**：多数 benchmark 只算准确率，说「不知道」和答错一样得 0 分，模型被训练得更倾向于猜（OpenAI, *Why Language Models Hallucinate*, 2025）。\n4. **上下文冲突或噪音**，以及长生成中的**误差累积**：前面采样错了一个 token，后面为了自洽继续编。',
    ref: `${R}#来源`,
  },
  {
    id: 'samp-citation-db-check',
    deck: 'ai',
    topic: '幻觉',
    q: 'DocPilot 让模型在每个事实后面写 `[c:<chunk_id>]`。如果模型编造了一个不存在的 id，会发生什么？为什么这样设计？',
    a: '生成结束后，`citations.py` 把所有 id **回数据库查一遍**，查不到的 id **不产生引用**，界面上显示为没有出处的文字，而不是指向一个错误的来源。\n设计意图：用 id 把**模型说的话**和**数据库里的事实**连起来，幻觉就从「看不出来」变成「可检测、可度量」。配合 eval 里的 citation faithfulness（judge 拿着被引用的原文检查论断是否被支持）和无答案题的拒答准确率。',
    ref: `${R}#后端能做的事`,
  },
  {
    id: 'samp-self-consistency',
    deck: 'ai',
    topic: '采样',
    q: 'self-consistency（同一问题采样多次取多数）的代价是什么？适合什么任务？',
    a: '**代价**：N 次采样就是 N 倍的输出 token 和成本；并行采样时，延迟约等于最慢的那一次。\n**适合**：答案能归一比较的任务，比如数学、分类、抽取单个数字，投票能显著提高准确率。\n**不适合**：开放式长文本没法直接投票，要再用一个模型聚合，收益小得多。\n相关技巧：用 **logprobs** 当置信度，低于阈值就转人工或拒答。',
    ref: `${R}#_4-想要稳定-就利用随机性本身`,
  },
]
