/**
 * 学一个新东西时唯一要改的文件：站点标题、笔记目录、分层图、闪卡牌组。
 *
 * 仓库名 / GitHub Pages 的 base / 闪卡同步的 data 分支都不用填，
 * 构建时从 GITHUB_REPOSITORY（Actions）或 `git remote get-url origin`（本地）推出来。
 *
 * 改完跑 `npm run scaffold`：给每层、每个小主题补上 docs/stack/<id>.md 占位页，给每个目录补 index.md。
 */
import { defineLearn } from './src/lib/config.ts'

/** 每层左边是传统后端，右边是 AI / Agent 带来的新东西 */
const CLASSIC = '传统'
const AI = 'AI 新增'

export default defineLearn({
  title: 'Backend Note',
  description: 'AI 时代的后端知识地图：每层左边是传统后端，右边是把 LLM 当作下游依赖后多出来的东西',
  lang: 'zh-CN',

  /** 笔记目录：docs/<dir>/*.md。颜色用在分层图面板和侧边栏 */
  domains: [
    { dir: 'backend', label: '传统后端', short: '后端', color: '#3b82f6', order: 1 },
    { dir: 'ai', label: 'AI 新增', short: 'AI', color: '#8b5cf6', order: 2 },
  ],

  /**
   * 分层图。第一张图画在首页，其余各占一页（home）。
   * 层从下往上编号，0 是最底层的地基；每层拆 3–5 个小主题。
   * 小主题 id 全站唯一，文章用 frontmatter `stack: [<小主题 id> | <层 key>]` 挂上来。
   * 层 key：第一张图是 layer-N，其余图是 <图 id>-layer-N。
   */
  stacks: [
    {
      id: 'main',
      name: '后端知识地图',
      home: '/',
      prefix: 'L',
      rail: { down: 'request', up: 'response' },
      layers: [
        {
          id: 0, name: '地基', en: 'Foundations', short: '地基', color: '#64748b',
          scope: '服务跑在什么上面；LLM 作为一种新依赖，它慢、贵、不确定的根源也在这层',
          topics: [
            { id: 'f-net', name: '网络：TCP / HTTP / TLS', group: CLASSIC },
            { id: 'f-os-io', name: 'OS 与 IO 模型', group: CLASSIC },
            { id: 'f-concurrency', name: '并发模型', group: CLASSIC },
            { id: 'llm-token', name: 'Token 与上下文窗口', group: AI },
            { id: 'llm-sampling', name: '采样、非确定性与幻觉', group: AI },
            { id: 'llm-latency-cost', name: '延迟与成本模型：prefill / decode', group: AI },
          ],
        },
        {
          id: 1, name: '接口', en: 'Interface', short: '接口', color: '#0ea5e9',
          scope: '服务对外的契约；对模型来说，tool schema 就是新的 API',
          topics: [
            { id: 'api-design', name: 'API 设计与序列化', group: CLASSIC },
            { id: 'api-auth', name: '认证与鉴权', group: CLASSIC },
            { id: 'api-idempotency', name: '幂等与错误语义', group: CLASSIC },
            { id: 'api-streaming', name: '流式接口：SSE / WebSocket', group: CLASSIC },
            { id: 'gw-api', name: 'Provider API 与结构化输出', group: AI },
            { id: 'ag-tools', name: 'Tool calling 与 MCP', group: AI },
          ],
        },
        {
          id: 2, name: '数据与状态', en: 'Storage', short: '存储', color: '#22c55e',
          scope: '状态放在哪、怎么查；AI 带来了向量、记忆和对 prompt 的缓存',
          topics: [
            { id: 'st-sql', name: '索引、事务与隔离级别', group: CLASSIC },
            { id: 'st-cache', name: '缓存', group: CLASSIC },
            { id: 'st-nosql', name: 'NoSQL 与全文检索', group: CLASSIC },
            { id: 'st-vector', name: 'Embedding 与向量索引', group: AI },
            { id: 'ctx-memory', name: '会话与记忆', group: AI },
            { id: 'gw-cache', name: 'Prompt caching 与语义缓存', group: AI },
          ],
        },
        {
          id: 3, name: '上下文工程', en: 'Context', short: '上下文', color: '#14b8a6', tag: '新增',
          scope: '决定每次调用时模型看到什么；传统后端里没有对应的一层',
          topics: [
            { id: 'ctx-prompt', name: 'Prompt 设计与版本管理', group: AI },
            { id: 'ctx-rag', name: 'RAG：切分、检索与重排', group: AI },
            { id: 'ctx-compaction', name: '上下文压缩', group: AI },
          ],
        },
        {
          id: 4, name: '异步与编排', en: 'Orchestration', short: '编排', color: '#eab308',
          scope: '把事情拆出请求路径并保证做完；Agent 循环就是一种长时间运行的编排',
          topics: [
            { id: 'mq-broker', name: '消息队列', group: CLASSIC },
            { id: 'mq-jobs', name: '后台任务', group: CLASSIC },
            { id: 'mq-outbox', name: 'Outbox 与事件驱动', group: CLASSIC },
            { id: 'mq-workflow', name: '工作流与 durable execution', group: CLASSIC },
            { id: 'ag-loop', name: 'Agent 循环', group: AI },
            { id: 'ag-durable', name: '长任务与 human-in-the-loop', group: AI },
          ],
        },
        {
          id: 5, name: '分布式与韧性', en: 'Distributed', short: '分布式', color: '#f97316',
          scope: '多节点下的一致性与容错；对 LLM 供应商的限流和 fallback 是同一套思路',
          topics: [
            { id: 'ds-replication', name: '复制与一致性：CAP / Raft', group: CLASSIC },
            { id: 'ds-sharding', name: '分片', group: CLASSIC },
            { id: 'ds-txn', name: '分布式事务与 Saga', group: CLASSIC },
            { id: 'ds-resilience', name: '限流、熔断与重试', group: CLASSIC },
            { id: 'gw-routing', name: 'LLM 网关：路由 / fallback / 配额', group: AI },
          ],
        },
        {
          id: 6, name: '运行与质量', en: 'Operations', short: '运维', color: '#ef4444',
          scope: '怎么上线、怎么知道它是好的；输出不确定时，"好"要靠 eval 来定义',
          topics: [
            { id: 'ops-deploy', name: '容器、K8s 与 CI/CD', group: CLASSIC },
            { id: 'ops-observability', name: '可观测性：日志 / 指标 / trace', group: CLASSIC },
            { id: 'ops-release', name: '发布：灰度与 feature flag', group: CLASSIC },
            { id: 'ev-offline', name: '离线 eval 与 LLM-as-judge', group: AI },
            { id: 'ev-tracing', name: 'LLM tracing：token / 成本 / 延迟', group: AI },
            { id: 'ev-online', name: '线上回归与 A/B', group: AI },
          ],
        },
        {
          id: 7, name: '安全', en: 'Security', short: '安全', color: '#db2777',
          scope: '攻击面与合规；模型读不可信输入、能调工具之后，攻击面多了一大块',
          topics: [
            { id: 'sec-owasp', name: '应用安全：OWASP', group: CLASSIC },
            { id: 'sec-privacy', name: '数据隐私与 PII', group: CLASSIC },
            { id: 'sec-injection', name: 'Prompt injection', group: AI },
            { id: 'sec-sandbox', name: 'Agent 权限与沙箱', group: AI },
            { id: 'sec-guardrails', name: 'Guardrails', group: AI },
          ],
        },
        {
          id: 8, name: '架构与权衡', en: 'Architecture', short: '架构', color: '#a855f7',
          scope: '把下面各层组合成系统，在性能、成本、复杂度之间取舍',
          topics: [
            { id: 'arch-boundaries', name: '服务边界：单体 / 微服务', group: CLASSIC },
            { id: 'arch-capacity', name: '容量估算与高并发设计', group: CLASSIC },
            { id: 'arch-cost', name: '成本', group: CLASSIC },
            { id: 'ai-interaction', name: '同步 / 异步交互模式', group: AI },
            { id: 'ai-cost', name: '模型分级与 batch', group: AI },
            { id: 'ai-selfhost', name: '自托管推理还是调 API', group: AI },
          ],
        },
      ],
    },
  ],

  /** 闪卡牌组：卡片在 src/data/flashcards.ts */
  decks: [
    { id: 'backend', label: '传统后端', color: '#0e7490' },
    { id: 'ai', label: 'AI 新增', color: '#7c3aed' },
  ],
})
