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
]

/** 删掉的卡：data 分支和各设备的本地缓存里可能还留着它们的复习记录、批注，页面不显示，测试放行 */
export const retiredIds: string[] = ['example-what', 'example-code']
