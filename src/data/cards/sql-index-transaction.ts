import type { Card } from '@lib/flashcards'

const R = '/backend/sql-index-transaction'

export const cards: Card[] = [
  {
    id: 'sql-why-bplus',
    deck: 'backend',
    topic: '索引',
    q: '数据库索引为什么用 B+ 树，而不是哈希表或二叉搜索树？估算 3 层 B+ 树能覆盖多少行。',
    a: '- **哈希**：只支持等值查询，不支持范围和排序。\n- **二叉树**：太高，10 亿行约 30 层，每层一次随机 IO。\n- **B+ 树**：一个节点一页，扇出几百；内部节点只存 key，扇出更大；**叶子节点用链表相连**，范围扫描是顺序读。\n扇出约 500 时，3 层 ≈ $500^3 \\approx 1.25 \\times 10^8$ 行。上层节点常驻内存，一次点查只需 1–2 次 IO。',
    ref: `${R}#为什么是-b-树`,
  },
  {
    id: 'sql-leftmost-covering',
    deck: 'backend',
    topic: '索引',
    q: '什么是最左前缀原则和覆盖索引？查询 `WHERE conversation_id = ? ORDER BY created_at` 该建什么索引？',
    a: '- **最左前缀**：联合索引 `(a, b, c)` 只能服务以 a 开头的条件。等值列在前、范围列在后，范围列之后的列用不上。\n- **覆盖索引**：查询需要的列都在索引里，**不用回表**（PostgreSQL 用 `INCLUDE` 和 index-only scan）。\n这个查询建 **`(conversation_id, created_at)`**：等值列在前，排序列在后，**WHERE 和 ORDER BY 由同一个索引服务**，不需要额外排序。DocPilot 的 `messages_conversation_idx` 就是这么建的。',
    ref: `${R}#用好索引的规则`,
  },
  {
    id: 'sql-acid-impl',
    deck: 'backend',
    topic: '事务',
    q: 'ACID 的四个性质分别靠什么机制实现？为什么 WAL 能让提交变快？',
    a: '- **原子性 + 持久性**：**WAL**。修改数据页之前，先把变更顺序写进日志并 fsync，崩溃后重放日志。\n- **隔离性**：**MVCC + 锁**。\n- **一致性**：约束（主键、外键、唯一、CHECK）加应用逻辑。\nWAL 让提交只需要**顺序写**日志并 fsync，数据页可以之后再刷盘；group commit 把多个事务的 fsync 合并成一次。',
    ref: `${R}#acid-各靠什么实现`,
  },
  {
    id: 'sql-isolation-levels',
    deck: 'backend',
    topic: '隔离级别',
    q: '四种隔离级别各防住哪些异常？PostgreSQL 的 Repeatable Read 是怎么实现的，防不住什么？',
    a: 'RU：什么都不防 → **RC**（PG 默认）：防脏读 → **RR**（MySQL 默认）：再防不可重复读 → **Serializable**：防所有异常，包括写偏斜。\nPostgreSQL 的 RR 是**快照隔离**：整个事务用同一个 MVCC 快照（RC 是每条语句一个快照），没有幻读，但**防不住写偏斜**。Serializable 在快照隔离之上做 **SSI**，检测危险的读写依赖，让其中一个事务失败，应用要重试。',
    ref: `${R}#隔离级别与异常`,
  },
  {
    id: 'sql-write-skew',
    deck: 'backend',
    topic: '隔离级别',
    q: '什么是写偏斜（write skew）？为什么快照隔离防不住它？怎么避免？',
    a: '两个事务读同一组数据，根据读到的结果**分别写不同的行**，单看都合法，合起来违反约束。例子：要求至少一个医生在岗，两人同时看到「另一个人在岗」，都请了假。\n快照隔离只检测**写写冲突**，而这两个事务写的是不同的行，没有冲突。\n避免：用 Serializable（SSI）、`SELECT ... FOR UPDATE` 锁住被读的行，或者把约束物化成一行或一个唯一约束，让它变成写写冲突。',
    ref: `${R}#隔离级别与异常`,
  },
  {
    id: 'sql-lost-update',
    deck: 'backend',
    topic: '并发',
    q: '两个事务并发地「读余额 → 加钱 → 写回」，丢了一次更新。有哪四种修法？怎么选？',
    a: '1. **原子更新**：`SET balance = balance + 10`，能写成单条语句就用它，最简单。\n2. **悲观锁**：`SELECT ... FOR UPDATE`，适合冲突多、临界区短的场景。\n3. **乐观锁**：`WHERE id = ? AND version = ?`，影响 0 行就重试，适合冲突少的场景。\n4. **Serializable** + 冲突重试。',
    ref: `${R}#丢失更新-最常见的并发-bug`,
  },
  {
    id: 'sql-now-clock-timestamp',
    deck: 'backend',
    topic: 'PostgreSQL',
    q: 'DocPilot 在同一个事务里插入 user 和 assistant 两条消息，为什么 assistant 那条要用 `clock_timestamp()` 而不是默认的 `now()`？',
    a: 'PostgreSQL 的 **`now()` 返回事务开始的时间**，同一个事务里调用多少次都一样。两条消息的 `created_at` 会完全相同，`ORDER BY created_at` 的顺序就不确定，历史可能变成先回答后提问。\n`clock_timestamp()` 返回**语句执行时的真实时间**。\n更稳妥的做法是加一个**单调递增的序号列**：时间戳可能相同，多个节点之间还有时钟偏差。',
    ref: `${R}#一个隐蔽的坑-now-在事务里是不变的`,
  },
  {
    id: 'sql-long-txn',
    deck: 'backend',
    topic: '事务',
    q: '为什么长事务危险？DocPilot 的 ingest 流程是怎么避免在事务里做慢操作的？',
    a: '长事务会：1. 一直占着连接；2. 持有的行锁阻塞其他写入；3. 旧快照让 **VACUUM 清不掉旧版本**，表和索引膨胀；4. 复制延迟变大。\nDocPilot 的 `ingest_text` **先调用 embedding API** 算出所有向量（可能要几秒），**再开一个短事务**，用 `executemany` 把 document 和所有 chunk 一次性写入。\n原则：事务里不调用外部服务。必须和外部调用保持一致的话，用 Outbox 模式。',
    ref: `${R}#实战-docpilot-的两个事务`,
  },
]
