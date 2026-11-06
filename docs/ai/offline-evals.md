---
title: 离线 eval 与 LLM-as-judge：LLM 应用的测试
status: draft
tags: [evals, llm-as-judge, rag-evaluation, ci, metrics]
difficulty: 4
order: 15
related: [/ai/rag, /ai/sampling-nondeterminism, /ai/prompt-versioning, /ai/llm-tracing, /ai/online-evals-ab, /backend/containers-cicd]
stack: [ev-offline]
---

# {{ $frontmatter.title }}

## 一句话结论

eval 就是 LLM 应用的测试：==一个固定的数据集，自动打分，和基线对比==，在每次修改 prompt、模型、检索策略时运行，用来防止回归，也用来做选型。几个关键点：

- 数据集要接近真实的问题分布，并覆盖难例（多跳问题、没有答案的问题）；
- 标签要经得起改动（用原文片段标注，而不是 chunk id）；
- 检索和生成**分开**评估；
- 能用确定性规则判断的，就不用模型；
- LLM-as-judge 作为补充，并且要用人工抽查来校准；
- 看结果时要考虑**噪声**：110 道题的数据集上，几个百分点的变化可能只是随机波动。

## 为什么 LLM 应用需要 eval，而不只是单元测试

输出是不确定的，「对」也不是一个字符串（见[采样与非确定性](/ai/sampling-nondeterminism)）。更关键的是，一个 prompt 或检索参数的改动，可能让 70% 的问题变好、10% 的问题变差。看几个例子根本发现不了。只有在一个固定的、足够大的问题集上，按同样的标准打分，才能回答「这次改动整体上是变好了还是变坏了，坏在哪里」。

## 实战：DocPilot 的 eval 怎么设计

### 数据集

- **语料是虚构的**：14 篇文档，构成一家虚构创业公司（Lumen Labs）的内部 wiki。==用虚构的内容，模型就不可能靠训练数据里的知识答对==，测出来的才是「基于文档回答」的能力。
- **110 道题，分三类**：62 道单文档题，37 道需要综合多篇文档的题，11 道文档里**没有答案**的题（用来测拒答）。
- **每道可回答的题，都附上证据的原文片段**（quote）。比如「Beacon 在哪个端口终止 TLS？」的证据是文档里的原句「It terminates TLS on port 8443…」。
- **标签会被自动校验**：`python -m evals.dataset` 检查每个 quote 确实存在于对应的文档里，CI 里每次都会跑。改了语料却忘了改标签，CI 就会失败。

### 检索和生成分开评

**检索**（只调用 `/search`，不调用 LLM，便宜又快）：

- **相关性判定**：检索到的 chunk **包含标准答案的原文片段**（忽略空白差异）就算相关。==换一种切分方式，标签依然有效==，这是能放心做切分实验的前提。
- **recall@5**：前 5 个结果覆盖了多少条证据。需要两篇文档的题只找到一篇，得 0.5 分。
- **MRR**：第一个相关结果排在第几位，取倒数后平均。
- 支持同时跑多种配置做消融：`--modes vector,hybrid --rerankers none,cohere`。

**生成**（走 `/chat`，完整的 agent 流程）：

| 指标 | 怎么算 | 在哪些题上算 |
|---|---|---|
| 正确率 | judge 对照参考答案判断 | 可回答的题 |
| 引用忠实度 | judge 拿着被引用的原文，检查每个带引用的论断是否被支持 | **可回答、且没有拒答**的题 |
| 拒答准确率 | 是否拒答 | 无答案的题 |
| 误拒率 | 是否拒答 | 可回答的题 |
| 引用命中率 | **确定性检查**：被引用的 chunk 里是否包含证据原文 | 没有拒答的题 |
| 延迟 p50 / p95、总成本 | 来自每一轮的 trace | 全部 |

一个细节：引用忠实度只在**没有拒答**的回答上计算。如果把拒答也算进去，「什么都不说」天然就是忠实的，模型拒答得越多，这个指标反而越好看。==每个指标都要想清楚分母是什么，防止它被投机取巧地优化==。

### 隔离和复现

- 每次运行先**重置一个独立的数据库 schema**（`docpilot_eval`），再通过 `POST /documents` 灌入语料，不会污染开发数据，每次的起点也都一样。
- 所有请求都走**生产代码路径**：用 `httpx.ASGITransport` 在进程内调用同一个 FastAPI app，而不是另写一套评测逻辑（见 [API 设计](/backend/api-design)）。
- 用 Semaphore 把并发限制在 4，避免触发供应商的限流。
- 单道题 judge 失败，只把这一题标记为错误，**不影响整次运行**。

## LLM-as-judge

### 怎么用

DocPilot 的 `evals/judge.py`：

- judge 拿到：问题、参考答案（无答案的题则是「UNANSWERABLE」）、候选回答，以及**每个被引用 chunk 的原文**。有了原文，「引用是否忠实」才是可以判断的。
- 输出用 **JSON Schema 约束**的结构化结果：`correct`、`citations_faithful`、`refused` 三个布尔值，加一句解释。不用解析自由文本（见[结构化输出](/stack/gw-api)）。
- 解析之前先检查 `stop_reason`，遇到拒答或者被截断就报错，而不是解析半截的 JSON。
- judge 的推理深度设为 `low`，控制成本。

### judge 的偏差

judge 本身也是一个模型，有已知的偏差：

- **位置偏差**：成对比较时偏向先出现（或后出现）的那个；
- **长度偏差**：偏向更长、更详细的回答；
- **自我偏好**：偏向和自己同一家族的模型的回答；
- **宽松**：倾向于判「对」。

缓解办法：

1. **用二元判断代替打分**：「是否包含参考答案的关键事实，且没有矛盾」比「给 1–10 分」稳定得多。DocPilot 的三个判断都是布尔值。
2. **给出参考答案和明确的标准**，而不是让 judge 凭自己的知识判断。
3. **成对比较时交换顺序**再判一次。
4. **用不同家族的模型做 judge**。DocPilot 的 judge 默认用的模型和回答问题的模型同属一个家族（都是 `claude-opus-5-5`，可以通过 `JUDGE_MODEL` 环境变量换掉），存在自我偏好的风险。
5. **人工校准**：`evals/spotcheck.py` 从一次运行结果里随机抽 20 道题，生成一份表格，人逐题判断，再和 judge 的结论对比。==judge 和人的一致率，决定了 judge 给出的分数能信几分==。

## 结果里的噪声

110 道题看起来不少，但算一下：

- 每道题约占 0.9 个百分点。两次运行之间有 2 道题的结果翻转，就是 1.8 个百分点的「变化」。
- 正确率在 80% 左右时，二项分布的标准误约为 $\sqrt{0.8 \times 0.2 / 110} \approx 3.8\%$，95% 置信区间大约是 **±7.5 个百分点**。
- 模型本身有随机性，judge 也有随机性，同一份代码跑两次结果也会不同。

所以：

- **不要因为 2–3 个百分点的变化就下结论**；
- **成对比较**：新旧版本在**同一批题**上对比，统计「旧版对、新版错」和「旧版错、新版对」各有多少题（McNemar 检验），比比较两个总分灵敏得多；
- **逐题看翻转的样本**：哪些题从对变错了，为什么，往往比总分更有价值；
- 需要更稳定的结论时，重复运行几次，或者扩充数据集。

## 接进 CI

DocPilot 的 `.github/workflows/evals.yml`：

- **只在相关的改动上触发**：PR 修改了 `agent/`、`ingest/`、`retrieval/`、`embeddings.py` 或者 `evals/` 才运行；
- **没有密钥时降级**：没有 `OPENAI_API_KEY` 就改用离线的假 embedder，没有 `ANTHROPIC_API_KEY` 就只跑检索评测，并且**在 PR 评论里写明用了哪种降级**；
- **和 baseline 对比**：`evals/compare.py` 生成一张差异表，每个指标标出变好还是 **变坏**（延迟、成本、误拒率这些是越低越好）；如果这次运行和 baseline 用的 embedder、LLM 或 judge 不同，会**特别提示「差值不可比」**；
- 结果作为一条**会被更新的 PR 评论**贴出来，原始结果作为构建产物保存。

一个诚实的现状：仓库里的 `baseline.json` 是用离线的假 embedder 生成的（只有检索部分），README 里明确要求在第一次用真实模型跑完之后重新生成，结果表目前也还是 TBD。==eval 的框架搭好了，并不等于已经有了可信的数字==。

## 追问

::: details 为什么 LLM 应用需要 eval？它和单元测试有什么区别？
LLM 的输出不确定，正确答案不是一个固定的字符串；一个 prompt 或检索的改动，可能让一部分问题变好、另一部分变差，看几个例子发现不了。eval 用固定的数据集和打分标准，衡量整体是变好还是变坏、坏在哪里。单元测试测确定性的代码路径（DocPilot 用假的 LLM 测 agent 循环），eval 测质量，两者都需要。
:::

::: details 怎么构建一个 RAG 的 eval 数据集？DocPilot 为什么用虚构的语料？
覆盖真实的问题分布和难例：单文档题、需要综合多篇文档的题、文档里没有答案的题。每道题附上标准答案和证据的原文片段，并用脚本校验原文确实存在。DocPilot 用一家虚构公司的 wiki 作为语料，是为了让模型无法靠训练数据里的知识答对，测出来的才是「基于文档回答」的能力。数据集还要持续用线上发现的失败案例来扩充。
:::

::: details 为什么用「原文片段」而不是 chunk id 来标注检索的相关性？
chunk id 依赖切分方式：一改 chunk 大小或切分策略，id 全变，标签就失效了，也就没法做切分方式的对比实验。用原文片段标注时，检索到的 chunk 只要包含这段原文就算相关，和切分方式无关。
:::

::: details 为什么引用忠实度只在没有拒答的回答上计算？
拒答没有任何论断，天然就是「忠实」的。如果把拒答也算进分母，模型拒答得越多，忠实度反而越高，这个指标就会鼓励错误的行为。每个指标都要想清楚分母，避免它被投机取巧地优化。DocPilot 用单独的拒答准确率和误拒率来衡量拒答行为。
:::

::: details LLM-as-judge 有哪些偏差？怎么让它更可信？
位置偏差、长度偏差、自我偏好（偏向同家族模型的回答）、过于宽松。办法：用二元判断代替 1–10 分；提供参考答案和明确的标准；成对比较时交换顺序；用不同家族的模型做 judge；最重要的是人工抽查校准，DocPilot 的 spotcheck 随机抽 20 道题让人判断，再和 judge 对比一致率。
:::

::: details eval 的分数从 0.80 变成 0.82，能说明改动有效吗？
不一定。110 道题时，每道题约 0.9 个百分点，正确率 80% 附近的标准误约 3.8%，95% 置信区间约 ±7.5 个百分点；模型和 judge 本身也有随机性。应该在同一批题上做成对比较（统计翻转的题，用 McNemar 检验），逐题查看从对变错的样本，必要时重复运行或者扩充数据集。
:::

::: details 怎么把 eval 接进 CI？
只在相关路径改动时触发，因为 eval 又慢又贵；运行结果和 baseline 对比，生成差异表贴到 PR 评论；标明每个指标是越高越好还是越低越好；配置（embedder、LLM、judge）和 baseline 不一致时，提示差值不可比；缺少密钥时降级运行，并在评论里写明。DocPilot 的 `evals.yml` 和 `compare.py` 都是这么做的。
:::

## 参考

- Hamel Husain, [Your AI Product Needs Evals](https://hamel.dev/blog/posts/evals/)
- Zheng et al., [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685)（judge 的位置、长度、自我偏好偏差）
- [Anthropic: Create strong empirical evaluations](https://docs.anthropic.com/en/docs/test-and-evaluate/develop-tests)
- Es et al., [RAGAS: Automated Evaluation of Retrieval Augmented Generation](https://arxiv.org/abs/2309.15217)
- Evan Miller, [Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640)（eval 结果的统计显著性）
- 实战代码：DocPilot `evals/`（`dataset.py`、`metrics.py`、`run.py`、`judge.py`、`compare.py`、`spotcheck.py`、`dataset.jsonl`）、`.github/workflows/evals.yml`
