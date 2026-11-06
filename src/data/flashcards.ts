// 闪卡：直接改这个文件，页面自动更新。
//
// id 是复习记录的 key（src/data/flashcard-progress.json），改题面可以，改 id 会丢掉这张卡的记录。
// deck 要在 learn.config.ts 的 decks 里登记；topic 是卡面上的小标题。
// a 支持行内 `code`、**加粗**、$公式$、$$单独一行的公式$$ 和 \n 换行；
// qcode 是题面上的代码块（翻面前就显示），code 是答案下面的代码块，fig 是等宽字符画（手机上别超过 40 列）；
// ref 是出处：站内链接，不含 base，可带 #锚点（测试会检查页面存在）。多行代码用 lines`...` 写，可以跟着缩进。

import { lines, type Card } from '@lib/flashcards'

const EX = '/notes/example'

export const cards: Card[] = [
  {
    id: 'example-what',
    deck: 'core',
    topic: '示例',
    q: '这个模板的三件套是什么？',
    a: '1. **分层图**：把一个领域从地基到应用拆成几层，每层几个小主题。\n2. **每格一篇**：`docs/stack/<id>.md` 是格子的基础介绍，深入的笔记用 frontmatter `stack` 挂上来。\n3. **闪卡**：从笔记里提问，`ref` 链回出处，FSRS 排复习。',
    ref: EX,
  },
  {
    id: 'example-code',
    deck: 'core',
    topic: '示例',
    q: '下面这段代码输出什么？',
    qcode: lines`
      xs = [1, 2, 3]
      print(sum(x * x for x in xs))
    `,
    a: '`14`：$1^2 + 2^2 + 3^2 = 14$。',
    ref: `${EX}#为什么`,
  },
]

/** 删掉的卡：data 分支和各设备的本地缓存里可能还留着它们的复习记录、批注，页面不显示，测试放行 */
export const retiredIds: string[] = []
