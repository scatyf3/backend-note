// 闪卡：直接改这个文件，页面自动更新。
//
// id 是复习记录的 key（src/data/flashcard-progress.json），改题面可以，改 id 会丢掉这张卡的记录。
// deck 要在 learn.config.ts 的 decks 里登记；topic 是卡面上的小标题。
// a 支持行内 `code`、**加粗**、$公式$、$$单独一行的公式$$ 和 \n 换行；
// qcode 是题面上的代码块（翻面前就显示），code 是答案下面的代码块，fig 是等宽字符画（手机上别超过 40 列）；
// ref 是出处：站内链接，不含 base，可带 #锚点（测试会检查页面存在）。多行代码用 lines`...` 写，可以跟着缩进。

import type { Card } from '@lib/flashcards'
import { cards as networkTcpHttpTls } from './cards/network-tcp-http-tls'
import { cards as osIoModels } from './cards/os-io-models'
import { cards as concurrencyModels } from './cards/concurrency-models'
import { cards as tokensContextWindow } from './cards/tokens-context-window'
import { cards as samplingNondeterminism } from './cards/sampling-nondeterminism'
import { cards as llmLatencyCost } from './cards/llm-latency-cost'
import { cards as apiDesign } from './cards/api-design'
import { cards as auth } from './cards/auth'
import { cards as idempotency } from './cards/idempotency'
import { cards as streamingSseWebsocket } from './cards/streaming-sse-websocket'
import { cards as providerApi } from './cards/provider-api-structured-output'
import { cards as toolCallingMcp } from './cards/tool-calling-mcp'
import { cards as sqlIndexTransaction } from './cards/sql-index-transaction'
import { cards as caching } from './cards/caching'
import { cards as nosqlFulltext } from './cards/nosql-fulltext'
import { cards as embeddingVectorIndex } from './cards/embedding-vector-index'
import { cards as conversationMemory } from './cards/conversation-memory'
import { cards as promptSemanticCache } from './cards/prompt-semantic-cache'
import { cards as promptVersioning } from './cards/prompt-versioning'
import { cards as rag } from './cards/rag'
import { cards as contextCompaction } from './cards/context-compaction'
import { cards as messageQueue } from './cards/message-queue'
import { cards as backgroundJobs } from './cards/background-jobs'
import { cards as outboxEventDriven } from './cards/outbox-event-driven'
import { cards as durableExecution } from './cards/durable-execution'
import { cards as agentLoop } from './cards/agent-loop'
import { cards as longRunningAgents } from './cards/long-running-agents'
import { cards as replicationConsensus } from './cards/replication-consensus'
import { cards as sharding } from './cards/sharding'
import { cards as distributedTransactions } from './cards/distributed-transactions'
import { cards as rateLimitCircuitBreaker } from './cards/rate-limit-circuit-breaker'
import { cards as llmGateway } from './cards/llm-gateway'
import { cards as containersCicd } from './cards/containers-cicd'
import { cards as observability } from './cards/observability'
import { cards as progressiveDelivery } from './cards/progressive-delivery'
import { cards as offlineEvals } from './cards/offline-evals'
import { cards as llmTracing } from './cards/llm-tracing'
import { cards as onlineEvalsAb } from './cards/online-evals-ab'
import { cards as owasp } from './cards/owasp'
import { cards as privacyPii } from './cards/privacy-pii'
import { cards as promptInjection } from './cards/prompt-injection'
import { cards as agentSandbox } from './cards/agent-sandbox'
import { cards as guardrails } from './cards/guardrails'
import { cards as serviceBoundaries } from './cards/service-boundaries'
import { cards as capacityEstimation } from './cards/capacity-estimation'
import { cards as cost } from './cards/cost'
import { cards as interactionPatterns } from './cards/interaction-patterns'
import { cards as modelTieringBatch } from './cards/model-tiering-batch'

export const cards: Card[] = [
  ...networkTcpHttpTls,
  ...osIoModels,
  ...concurrencyModels,
  ...tokensContextWindow,
  ...samplingNondeterminism,
  ...llmLatencyCost,
  ...apiDesign,
  ...auth,
  ...idempotency,
  ...streamingSseWebsocket,
  ...providerApi,
  ...toolCallingMcp,
  ...sqlIndexTransaction,
  ...caching,
  ...nosqlFulltext,
  ...embeddingVectorIndex,
  ...conversationMemory,
  ...promptSemanticCache,
  ...promptVersioning,
  ...rag,
  ...contextCompaction,
  ...messageQueue,
  ...backgroundJobs,
  ...outboxEventDriven,
  ...durableExecution,
  ...agentLoop,
  ...longRunningAgents,
  ...replicationConsensus,
  ...sharding,
  ...distributedTransactions,
  ...rateLimitCircuitBreaker,
  ...llmGateway,
  ...containersCicd,
  ...observability,
  ...progressiveDelivery,
  ...offlineEvals,
  ...llmTracing,
  ...onlineEvalsAb,
  ...owasp,
  ...privacyPii,
  ...promptInjection,
  ...agentSandbox,
  ...guardrails,
  ...serviceBoundaries,
  ...capacityEstimation,
  ...cost,
  ...interactionPatterns,
  ...modelTieringBatch,
]

/** 删掉的卡：data 分支和各设备的本地缓存里可能还留着它们的复习记录、批注，页面不显示，测试放行 */
export const retiredIds: string[] = ['example-what', 'example-code']
