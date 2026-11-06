---
title: Token 与上下文窗口
status: draft
tags: [token, tokenizer, context-window, kv-cache]
difficulty: 2
order: 1
related: [/ai/llm-latency-cost, /ai/sampling-nondeterminism, /ai/rag, /ai/context-compaction]
stack: [llm-token]
---

# {{ $frontmatter.title }}

## 一句话结论

==token 是 LLM 的计量单位：计费、限流、上下文上限、延迟，全都按 token 算==。token 是 BPE 一类算法切出来的子词，英文平均约 4 个字符或 0.75 个词一个 token；中文和其他语言差异很大，而且**每家的 tokenizer 不一样，同一段文字在不同模型上的 token 数不同**。上下文窗口是**输入和输出共用**的上限，背后的约束是 KV cache 的显存和模型训练时见过的长度。窗口塞得下，不代表模型用得好。

## 为什么是子词

模型的输入是一串整数 id，所以得先把文本切成离散单元。有三种切法：

| 切法 | 问题 |
|---|---|
| 按字符 | 序列太长：attention 的计算量是 $O(n^2)$，一篇文章就是几万个字符 |
| 按词 | 词表会爆炸，新词、拼写错误、代码标识符都会变成 OOV（不在词表里） |
| **子词（BPE / WordPiece / Unigram）** | 折中：常见词是一个 token，罕见词拆成几块 |

BPE（Byte Pair Encoding）的训练过程是：从单个字节开始，反复把语料里最常出现的相邻一对合并成新 token，直到词表达到目标大小（常见是 10 万到 20 万）。**byte-level BPE** 的底层单元是字节，所以任何输入都能编码，不存在 OOV。

几个直接的后果：

- **常见英文单词通常是 1 个 token**（往往带着前导空格，比如 `" the"`），罕见词、长数字、URL、base64 会被拆得很碎。
- **模型其实「看不见」字母**：问「strawberry 里有几个 r」容易答错，因为它看到的是几个子词块，而不是一个个字母。
- **语言之间不公平**：tokenizer 的语料以英文为主，同样的意思用中文、日文、印地语表达往往要更多 token。成本更高、上下文更挤，延迟也更长（Petrov et al., 2023）。

## 估算口径

| 场景 | 经验值 |
|---|---|
| 英文 | 1 token ≈ 4 个字符 ≈ 0.75 个词；1000 词 ≈ 1333 token |
| 中文 | 一个汉字约 0.5–1.5 个 token，取决于 tokenizer，**要实测** |
| 代码 | 比英文散文更碎：缩进、符号、标识符都会多占 token |

精确计数要用对应模型的 tokenizer：OpenAI 用 `tiktoken`，Anthropic 提供 `count_tokens` API，开源模型用 Hugging Face 的 `AutoTokenizer`。**计费永远以供应商返回的 `usage` 为准。**

LLMGateway 的做法是一个很好的工程折中：路由规则和限流用 **约 4 字符 / token 的粗估**，因为只是比一个阈值，为每家供应商维护一个 tokenizer 不值得；**计费用后端返回的真实 usage**。流式请求会主动向上游要 `include_usage`，如果客户端没要求，就把 usage 那一块再藏起来，不返回给客户端。

## 实战：按空格数词，在中文上会坏掉

DocPilot 的切分器（`ingest/chunk.py`）为了不依赖 tokenizer，按空格数词来近似 token：

```python
WORDS_PER_TOKEN = 0.75

def approx_tokens(text: str) -> int:
    return math.ceil(len(text.split()) / WORDS_PER_TOKEN)
```

对英文语料（它的 eval 语料就是英文）这够用了。但**中文没有空格**：一整段中文 `split()` 之后只算 1 个「词」，长段落切窗口用的 `re.finditer(r"\S+")` 也会把整段当成一个单元。后果是：

1. `approx_tokens` 严重低估，一个「500 token 的 chunk」实际可能装进去几百段中文，也就是几万个 token；
2. 超长 chunk 会超过 embedding 模型的输入上限（`text-embedding-3-small` 是 8191 token），上传直接报错；即使没超限，一个巨大 chunk 的向量也只是全文的模糊平均，检索质量会很差。

修法：要么用真实的 tokenizer 计数（`tiktoken` 很快），要么对 CJK 文本按字符数估算。这个例子说明，==「token 约等于 0.75 个词」是英文的经验值，不是定律==，把它写进代码时要清楚它的适用范围。切分策略的完整讨论见 [RAG](/stack/ctx-rag)。

## 上下文窗口：输入和输出共用

一次调用的总 token 数 = 输入 + 输出，必须小于上下文窗口。输入又由几部分组成：

```
system prompt + 工具定义（JSON Schema 也算 token）+ 历史消息 + 检索到的文档 + 本轮问题
+ 预留的输出（max_tokens）
```

几个容易忽略的点：

- **工具定义也是输入**：每次调用都会把所有工具的 schema 发过去，工具多的话光这部分就有几千 token。
- **chat template 有开销**：每条消息都有角色标记等特殊 token。
- **max_tokens 要预留**：输出被截断时 `stop_reason` 是 `max_tokens` / `length`。DocPilot 的 agent loop 遇到这种情况会直接结束这一轮，**不执行被截断的 tool call**，因为参数可能只写了一半。

### Agent 循环的 token 是累加的

每一步调用都要把**完整的历史**再发一次，所以多步 agent 的输入 token 是每一步上下文长度之和，随步数大致呈平方增长。拿 DocPilot 的配置估一下：

- 一次 `search_docs` 返回 5 个约 500 token 的 chunk，约 2.5K token；
- 一次 `read_doc` 最多返回 40 个 chunk，约 20K token；
- 最多 6 步（`max_agent_steps = 6`）。

假设第 1 步调了 `read_doc`，那后面 5 步每一步都要重新发送这 20K token，光这一项累计就是 100K 输入 token。这就是为什么长 agent 任务要用 [prompt caching](/stack/gw-cache) 和[上下文压缩](/stack/ctx-compaction)。成本怎么算，见[延迟与成本模型](/stack/llm-latency-cost)。

## 窗口为什么不能无限大

### 约束 1：KV cache 显存

生成时，每个 token 在每一层都要缓存 K 和 V 两个向量：

$$\text{KV bytes / token} = 2 \times n_{layers} \times n_{kv\_heads} \times d_{head} \times \text{bytes}$$

以 Llama 3 70B 为例（80 层，GQA 有 8 个 KV head，$d_{head}=128$，bf16 每个数 2 字节）：

$$2 \times 80 \times 8 \times 128 \times 2 = 327{,}680 \text{ B} \approx 320 \text{ KB / token}$$

一个 128K token 的序列光 KV cache 就要约 40 GB，相当于半张 80 GB 的 H100。这就是长上下文贵、并发低的物理原因，也是 GQA、MLA、KV 量化这些技术存在的理由（推理侧的细节属于 AI infra 的范围）。

### 约束 2：attention 计算量

prefill 阶段 attention 的计算量是 $O(n^2)$，上下文翻倍，首 token 延迟（TTFT）中 attention 那部分会变成 4 倍。FlashAttention 省的是显存读写，FLOPs 并没有变少。

### 约束 3：训练长度和「用得好不好」

模型要在长序列上训练过（或者做过位置编码外推），长上下文才可靠。即便窗口标称很长，实测往往有两个问题：

- **lost in the middle**：信息放在上下文开头或结尾时模型用得最好，放在中间时准确率明显下降（Liu et al., 2023）。
- **上下文越长越容易分心**：塞进去的无关内容越多，回答质量越差，也就是常说的 context rot。

所以 ==长窗口是一个上限，不是一种策略==。把整个知识库塞进 prompt 通常比检索加精选更贵、更慢，效果也更差。RAG 和上下文压缩存在的意义就在这里。

## 后端要管的事

1. **预算化**：给每类请求定 token 预算，比如历史保留多少、检索文档最多多少、输出预留多少，超了就截断或摘要。
2. **限流按 token 算**：供应商的限额通常是 RPM（每分钟请求数）和 TPM（每分钟 token 数）两个维度，网关也得两个都管，见 [LLM 网关](/stack/gw-routing)。
3. **记录 usage**：每次调用都把输入 / 输出 token 记进 trace。DocPilot 的 `traces` 表每一轮存一行 `input_tokens` 和 `output_tokens`，再乘以价格表得到成本。
4. **多语言要测**：上线中文、日文用户前，先用真实语料测 token 膨胀系数，它会直接影响成本和上下文预算。

## 追问

::: details 为什么 LLM 用子词而不是字符或单词？
字符级序列太长，attention 是 $O(n^2)$，计算和显存都扛不住；单词级词表会爆炸，而且遇到新词、拼写错误、代码标识符就成了 OOV。子词（BPE）在两者之间取折中：常见词一个 token，罕见词拆成几块。byte-level BPE 以字节为底层单元，任何输入都能编码，没有 OOV。
:::

::: details 1000 个英文单词大约多少 token？一份 10 页的中文合同呢？
英文按 0.75 词 / token 算，大约 1333 token。中文不能套这个比例：一个汉字在不同 tokenizer 下约 0.5–1.5 个 token。10 页合同大约 1 万字，就是 5K–15K token 之间。正确的回答是给出范围，并说明要用目标模型的 tokenizer 实测，计费以 API 返回的 usage 为准。
:::

::: details 上下文窗口能不能做到无限大？限制在哪？
三个限制：

1. **KV cache 显存**随长度线性增长。Llama 3 70B 每个 token 约 320 KB，128K token 约 40 GB。
2. **prefill 的 attention 计算**是 $O(n^2)$，TTFT 会变长。
3. **模型能力**：要在长序列上训练过才可靠；即使窗口够大，也有 lost in the middle 和无关内容干扰的问题。

所以长窗口是上限，工程上还是要做检索和压缩。
:::

::: details 一个 agent 跑了 6 步，为什么输入 token 远远超过最终上下文的长度？
每一步都要把完整的历史（system prompt、工具定义、之前所有的工具结果）重新发一次，所以总输入 token = 每一步上下文长度之和，随步数大致平方增长。前面某一步读进来一个 20K token 的文档，后面每一步都要再付一次这 20K。缓解办法是 prompt caching（重复的前缀按折扣价计费）、压缩或丢弃旧的工具结果，以及限制单次工具返回的大小。
:::

::: details 网关做限流时需要精确的 token 数吗？
不需要。限流和路由只是跟一个阈值比较，用约 4 字符 / token 的粗估就够了，为每家供应商维护一个 tokenizer 成本太高。但输出 token 在请求发出时是未知的，LLMGateway 的做法是先按输入估算扣额度，等响应结束后再按真实 usage 补扣输出 token（post-paid），允许令牌桶暂时变成负数。**计费**则必须用供应商返回的真实 usage。
:::

::: details 为什么 RAG 的 chunk 大小要按 token 定，而不是按字符？
因为下游的限制都是按 token 算的：embedding 模型的输入上限、LLM 的上下文预算、检索结果的成本都是 token。按字符切，对不同语言和内容类型（代码、表格）实际的 token 数差别很大。可以用近似算法，但要知道它的适用范围：按空格数词在中文上会严重低估，DocPilot 的切分器就有这个问题。
:::

## 参考

- Sennrich et al., [Neural Machine Translation of Rare Words with Subword Units](https://arxiv.org/abs/1508.07909)（BPE 用于 NLP 的起点）
- [OpenAI tiktoken](https://github.com/openai/tiktoken)、[Anthropic: Token counting](https://docs.anthropic.com/en/docs/build-with-claude/token-counting)
- Petrov et al., [Language Model Tokenizers Introduce Unfairness Between Languages](https://arxiv.org/abs/2305.15425)
- Liu et al., [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172)
- [Llama 3 模型配置（Hugging Face）](https://huggingface.co/meta-llama/Meta-Llama-3-70B/blob/main/config.json)
- [OpenAI embeddings 文档](https://platform.openai.com/docs/guides/embeddings)（各模型的输入上限）
- 实战代码：DocPilot `api/src/docpilot/ingest/chunk.py`、`agent/loop.py`、`schema.sql`（`traces` 表）；LLMGateway README「Token counts」一节
