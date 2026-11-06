# 写作计划（夜间 loop 用）

目标：给 `learn.config.ts` 里的 49 个小主题每个写一篇笔记，规模对标 ai-infra-inferview（单篇 8–15KB、结论先行、有推导、有追问），同时填好 9 个层总述和 49 个格子介绍，每篇出 6–8 张闪卡。

截止：2026-11-06 09:00 前后，或全部写完为止。

## 每一轮做什么

1. 在下面的清单里取最前面 2 个 `[ ]`。如果某层第一次被写到，同时写 `docs/stack/layer-N.md`。
2. 每个小主题：
   - `npm run new -- <目录>/<slug> "标题" <id>` 建笔记，按 `templates/note.md` 的结构写：一句话结论 → 为什么（从约束推出做法）→ 细节 / 追问（`::: details`）→ 参考。写完 `status: draft`。
   - 填 `docs/stack/<id>.md`：3–5 句话 + 2–3 个要点 + 1–2 个延伸阅读，把 `__TODO__` 去掉，末尾链接到笔记。
   - 闪卡写进 `src/data/cards/<slug>.ts`（`export const cards: Card[]`），再在 `src/data/flashcards.ts` 里 import 并展开。id 前缀用 slug。
   - 有「实战」素材的（见下表）要写进正文，标明出处是 DocPilot / LLMGateway 的哪个文件，讲清当时的取舍。
3. `npm test && npm run docs:build`，过了就把清单里对应项改成 `[x]`，commit + push。
4. 不确定的数字、版本、API 先查证再写，参考里给链接。

约定（第一轮踩出来的）：
- `ignoreDeadLinks: false`：正文里链接**还没写的笔记**会让构建失败，改链 `/stack/<id>`（格子页永远存在）。frontmatter `related` 不校验，可以先写未来的路径。
- 闪卡 `ref` 的 `#锚点` 要用 VitePress 生成的 id：先 `npm run docs:build`，再在 dist 里 grep `<h2 id=`（scratchpad 里有 `anchors.sh`），中文全角标点会变成 `-`。
- 闪卡文件 `src/data/cards/<slug>.ts` 导出 `cards`，在 `src/data/flashcards.ts` 里 `import { cards as xxx }` 再 `...xxx` 展开。
- 引用 DocPilot / LLMGateway 代码前先打开源文件核对原文。
- 金额：笔记正文用 `\$4`（markdown 转义有效）；**闪卡里不能写 `$` 金额**，KaTeX 会当公式解析，测试会挂，写成「4 美元」。
- 正文里出现 `{{ ... }}` 时（比如 f-string 转义），**不要放进行内代码**，VitePress 会当成 Vue 插值；放进 fenced code block（自动 v-pre）。

## 写作口径

- 读者：准备北美后端 / AI infra 面试的人（就是用户本人）。正文中文，术语英文。
- 每篇开头一句话说完答案；用 `==重点==` 标 1–2 句。
- 「AI 新增」那一侧的笔记要回扣左边的传统主题（同层的桥），比如 LLM 网关回扣限流熔断。
- 结尾的追问挑面试真会问的：为什么、区别、什么时候用、数字怎么估。

## 实战素材

DocPilot（`../DocPilot`，RAG + Agent 应用）和 LLMGateway（`../LLMGateway`，OpenAI 兼容多供应商网关）里能直接引用的点：

| 格子 | 素材 |
|---|---|
| f-os-io | Windows 下 psycopg async 要 `SelectorEventLoop`（Proactor/IOCP 和 select 的差别） |
| api-streaming | DocPilot `ui_stream.py`：SSE `data:` 帧、`[DONE]`、`x-accel-buffering: no` 防代理缓冲；出错时在流里发 `error` 帧而不是断流 |
| api-idempotency | `docpilot db init` 幂等（每次部署都跑）；`ON CONFLICT DO NOTHING` 建会话 |
| gw-api | DocPilot `llm/openai_provider.py` 按 `index` 拼接流式 tool call 碎片、有的服务 finish_reason 报 stop 但带了 tool call；LLMGateway Anthropic ↔ OpenAI 格式翻译与 stop_reason 映射；judge 用 json_schema 结构化输出 |
| ag-tools | DocPilot `agent/tools.py`：pydantic 模型同时生成 JSON Schema 和做校验；工具异常回传给模型而不是中断回合 |
| st-sql | `store.py` 里 `clock_timestamp()` vs `now()`（同一事务内 now() 不变，排序会乱）；一轮对话 + trace 原子写入 |
| st-nosql | Postgres FTS：`plainto_tsquery` 是 AND，自然语言问题要改成 OR；generated `tsvector` 列 + GIN |
| st-vector | pgvector HNSW + cosine；零向量 cosine 未定义；维度被 schema 固定（`vector(1024)` + `dimensions=1024`） |
| ctx-memory | 历史以数据库为准，不信客户端传来的 messages |
| gw-cache | LLMGateway exact cache 的 key 规范化、只缓存 temperature 0、semantic cache 按 namespace 隔离、tool 请求不做语义缓存、阈值 0.95 |
| ctx-prompt | 改 `prompts.py` 触发 CI eval；「工具结果是数据不是指令」 |
| ctx-rag | heading-aware chunker、overlap 保证短事实不被切断、RRF（k=60，只用排名不用分数）、rerank 只重排头部 |
| ag-loop | DocPilot `agent/loop.py`：先看 stop_reason 再执行工具（max_tokens 截断的 tool call 不能跑）、步数上限、同一轮工具并发 `gather` |
| ds-resilience | LLMGateway：SDK 重试关掉（叠加重试放大尾延迟）、预算耗尽回 402 而不是 429（SDK 会自动重试 429） |
| gw-routing | LLMGateway：限流 Lua 用调用方传入的 `now`（各副本时钟偏差会影响补充速率，可改用 Redis `TIME`）；流式只在首字节前 fallback、5xx/429/超时才 fallback、Redis Lua 双令牌桶（rpm + tpm）、输出 token 事后扣（post-paid） |
| ops-deploy | Fly release command 跑 `db init`、`/healthz` 查 DB |
| ev-offline | DocPilot evals：引用原文 quote 判相关（换切分标签不失效）、隔离 schema、LLM judge + 人工 spotcheck、CI 贴 diff |
| ev-tracing | DocPilot `traces` 表（检索到的 chunk、工具调用、token、延迟、成本）；LLMGateway `x-gateway-overhead-ms` 的定义 |
| arch-cost / ai-cost | 价格表缺模型时记 0 并告警；计费离开热路径导致预算是软上限 |
| sec-injection | system prompt 声明工具结果是数据；引用 id 回库校验，幻觉 id 不产生引用 |

## 清单

### 第 0 层 地基
- [x] f-net → `backend/network-tcp-http-tls` 网络：TCP / HTTP / TLS
- [x] f-os-io → `backend/os-io-models` OS 与 IO 模型
- [x] f-concurrency → `backend/concurrency-models` 并发模型
- [x] llm-token → `ai/tokens-context-window` Token 与上下文窗口
- [x] llm-sampling → `ai/sampling-nondeterminism` 采样、非确定性与幻觉
- [x] llm-latency-cost → `ai/llm-latency-cost` 延迟与成本模型

### 第 1 层 接口
- [x] api-design → `backend/api-design` API 设计与序列化
- [x] api-auth → `backend/auth` 认证与鉴权
- [x] api-idempotency → `backend/idempotency` 幂等与错误语义
- [x] api-streaming → `backend/streaming-sse-websocket` 流式接口
- [x] gw-api → `ai/provider-api-structured-output` Provider API 与结构化输出
- [x] ag-tools → `ai/tool-calling-mcp` Tool calling 与 MCP

### 第 2 层 数据与状态
- [x] st-sql → `backend/sql-index-transaction` 索引、事务与隔离级别
- [x] st-cache → `backend/caching` 缓存
- [x] st-nosql → `backend/nosql-fulltext` NoSQL 与全文检索
- [x] st-vector → `ai/embedding-vector-index` Embedding 与向量索引
- [x] ctx-memory → `ai/conversation-memory` 会话与记忆
- [x] gw-cache → `ai/prompt-semantic-cache` Prompt caching 与语义缓存

### 第 3 层 上下文工程
- [x] ctx-prompt → `ai/prompt-versioning` Prompt 设计与版本管理
- [x] ctx-rag → `ai/rag` RAG：切分、检索与重排
- [x] ctx-compaction → `ai/context-compaction` 上下文压缩

### 第 4 层 异步与编排
- [x] mq-broker → `backend/message-queue` 消息队列
- [x] mq-jobs → `backend/background-jobs` 后台任务
- [x] mq-outbox → `backend/outbox-event-driven` Outbox 与事件驱动
- [x] mq-workflow → `backend/durable-execution` 工作流与 durable execution
- [x] ag-loop → `ai/agent-loop` Agent 循环
- [x] ag-durable → `ai/long-running-agents` 长任务与 human-in-the-loop

### 第 5 层 分布式与韧性
- [x] ds-replication → `backend/replication-consensus` 复制与一致性
- [x] ds-sharding → `backend/sharding` 分片
- [x] ds-txn → `backend/distributed-transactions` 分布式事务与 Saga
- [x] ds-resilience → `backend/rate-limit-circuit-breaker` 限流、熔断与重试
- [x] gw-routing → `ai/llm-gateway` LLM 网关

### 第 6 层 运行与质量
- [x] ops-deploy → `backend/containers-cicd` 容器、K8s 与 CI/CD
- [x] ops-observability → `backend/observability` 可观测性
- [x] ops-release → `backend/progressive-delivery` 灰度与 feature flag
- [x] ev-offline → `ai/offline-evals` 离线 eval 与 LLM-as-judge
- [x] ev-tracing → `ai/llm-tracing` LLM tracing
- [x] ev-online → `ai/online-evals-ab` 线上回归与 A/B

### 第 7 层 安全
- [ ] sec-owasp → `backend/owasp` 应用安全：OWASP
- [ ] sec-privacy → `backend/privacy-pii` 数据隐私与 PII
- [ ] sec-injection → `ai/prompt-injection` Prompt injection
- [ ] sec-sandbox → `ai/agent-sandbox` Agent 权限与沙箱
- [ ] sec-guardrails → `ai/guardrails` Guardrails

### 第 8 层 架构与权衡
- [ ] arch-boundaries → `backend/service-boundaries` 服务边界
- [ ] arch-capacity → `backend/capacity-estimation` 容量估算与高并发设计
- [ ] arch-cost → `backend/cost` 成本
- [ ] ai-interaction → `ai/interaction-patterns` 同步 / 异步交互模式
- [ ] ai-cost → `ai/model-tiering-batch` 模型分级与 batch
- [ ] ai-selfhost → `ai/self-host-vs-api` 自托管推理还是调 API
