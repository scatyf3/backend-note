import type { Card } from '@lib/flashcards'

const R = '/ai/offline-evals'

export const cards: Card[] = [
  {
    id: 'eval-why',
    deck: 'ai',
    topic: 'eval',
    q: '为什么 LLM 应用需要 eval？它和单元测试是什么关系？',
    a: 'LLM 的输出**不确定**，正确答案不是一个固定的字符串；一次 prompt 或检索的改动，可能让 70% 的题变好、10% 变差，**看几个例子发现不了**。eval 用固定的数据集和打分标准，回答「整体变好还是变坏、坏在哪」。\n关系：**单元测试**测确定性的代码路径（DocPilot 用假的 LLM 测 agent 循环和流式编码），**eval** 测质量，两者都需要。',
    ref: `${R}#为什么-llm-应用需要-eval-而不只是单元测试`,
  },
  {
    id: 'eval-dataset',
    deck: 'ai',
    topic: '数据集',
    q: 'DocPilot 的 RAG eval 数据集是怎么设计的？为什么语料要用一家虚构的公司？',
    a: '- 语料：14 篇文档，构成**虚构**创业公司 Lumen Labs 的 wiki。用虚构内容，模型**没法靠训练数据里的知识答对**，测出来的才是「基于文档回答」的能力。\n- 110 道题：**62 道单文档、37 道多文档、11 道无答案**（测拒答）。\n- 每道可回答的题附**证据原文片段**；`python -m evals.dataset` 在 CI 里校验每个片段确实存在于语料，改了语料忘改标签就会失败。',
    ref: `${R}#数据集`,
  },
  {
    id: 'eval-quote-label',
    deck: 'ai',
    topic: '标注',
    q: '为什么用「原文片段」而不是 chunk id 来标注检索的相关性？recall@5 在多文档题上怎么算？',
    a: '**chunk id 依赖切分方式**：一改 chunk 大小或切分策略，id 全变，标签就失效，也就没法做切分方式的对比实验。用原文片段标注时，检索到的 chunk **包含这段原文**（忽略空白）就算相关，和切分方式无关。\n**recall@5**：前 5 个结果覆盖了多少条证据。需要两篇文档的题只找到其中一篇，得 **0.5** 分。MRR 则看第一个相关结果的排名倒数。',
    ref: `${R}#检索和生成分开评`,
  },
  {
    id: 'eval-denominator',
    deck: 'ai',
    topic: '指标',
    q: '为什么 DocPilot 的引用忠实度只在「可回答且没有拒答」的回答上计算？这说明了设计指标时的什么原则？',
    a: '拒答没有任何论断，天然就是「忠实」的。如果把拒答也算进分母，模型**拒答得越多，忠实度越高**，这个指标就会鼓励错误的行为。\n原则：**每个指标都要想清楚分母**，防止它被投机取巧地优化。拒答行为由单独的指标衡量：**拒答准确率**（在无答案题上）和**误拒率**（在可回答题上）。',
    ref: `${R}#检索和生成分开评`,
  },
  {
    id: 'eval-judge-design',
    deck: 'ai',
    topic: 'LLM-as-judge',
    q: 'DocPilot 的 LLM judge 是怎么设计的？为什么要给 judge 看被引用 chunk 的原文？',
    a: '1. 输入：问题、**参考答案**（无答案题是 UNANSWERABLE）、候选回答、**每个被引用 chunk 的原文**；\n2. 输出：**JSON Schema 约束**的 `correct`、`citations_faithful`、`refused` 三个布尔值加一句解释，不用解析自由文本；\n3. 解析前先检查 `stop_reason`（拒答或截断就报错）；\n4. 推理深度设为 `low` 控制成本；单题失败不影响整次运行。\n给原文是因为：没有原文，judge 就**无法判断**「带引用的论断是否真的被所引用的内容支持」。',
    ref: `${R}#怎么用`,
  },
  {
    id: 'eval-judge-bias',
    deck: 'ai',
    topic: 'LLM-as-judge',
    q: 'LLM-as-judge 有哪些已知偏差？怎么让它更可信？',
    a: '**偏差**：位置偏差（偏向先 / 后出现的回答）、长度偏差（偏向更长的）、**自我偏好**（偏向同家族模型的回答）、过于宽松。\n**办法**：\n1. 用**二元判断**代替 1–10 分；\n2. 给**参考答案**和明确的标准；\n3. 成对比较时**交换顺序**再判一次；\n4. 用**不同家族**的模型做 judge（DocPilot 默认 judge 和回答模型同属一个家族，有自我偏好风险）；\n5. **人工校准**：`spotcheck.py` 抽 20 道题让人判断，看人和 judge 的一致率。',
    ref: `${R}#judge-的偏差`,
  },
  {
    id: 'eval-noise',
    deck: 'ai',
    topic: '统计',
    q: '110 道题的 eval，正确率从 0.80 变成 0.82，能说明改动有效吗？怎么更可靠地比较？',
    a: '**不一定**。每道题约 0.9 个百分点；正确率 80% 附近，标准误 $\\sqrt{0.8 \\times 0.2 / 110} \\approx 3.8\\%$，**95% 置信区间约 ±7.5 个百分点**；模型和 judge 本身还有随机性。\n更可靠的做法：\n1. **成对比较**：同一批题上统计「旧对新错」和「旧错新对」的数量（McNemar 检验），比比较两个总分灵敏得多；\n2. **逐题看翻转的样本**；\n3. 重复运行几次，或者扩充数据集。',
    ref: `${R}#结果里的噪声`,
  },
  {
    id: 'eval-ci',
    deck: 'ai',
    topic: 'CI',
    q: 'DocPilot 是怎么把 eval 接进 CI 的？有哪些设计值得借鉴？',
    a: '1. **只在相关路径改动时触发**（agent、ingest、retrieval、embeddings、evals），因为 eval 又慢又贵；\n2. **没有密钥时降级**：没有 OpenAI key 就用假 embedder，没有 Anthropic key 就只跑检索，并**在 PR 评论里写明**；\n3. `compare.py` 和 baseline 对比，每个指标标出变好或**变坏**（延迟、成本、误拒率越低越好）；\n4. embedder / LLM / judge 和 baseline 不一致时，提示**差值不可比**；\n5. 结果作为会被更新的 PR 评论，原始数据作为构建产物保存。',
    ref: `${R}#接进-ci`,
  },
]
