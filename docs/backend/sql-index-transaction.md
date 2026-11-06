---
title: 索引、事务与隔离级别
status: draft
tags: [database, postgres, index, transaction, mvcc, isolation]
difficulty: 4
order: 8
related: [/backend/caching, /backend/nosql-fulltext, /backend/concurrency-models, /backend/idempotency, /ai/embedding-vector-index]
stack: [st-sql]
---

# {{ $frontmatter.title }}

## 一句话结论

关系数据库有两根支柱。**索引**用 B+ 树把「全表扫描」变成「几次页读取」，代价是写放大和存储空间。**事务**用 WAL 保证原子性和持久性，用 MVCC 加锁实现隔离。==隔离级别是性能和异常之间的交易==：级别越低，并发越好，但会依次出现脏读、不可重复读、幻读、写偏斜。工程上最常见的事故不是「数据库坏了」，而是**读-改-写丢更新**、**长事务**拖垮整个库，以及**索引没用上**。

## 为什么需要索引：磁盘随机读很贵

数据按页存储（PostgreSQL 一页 8 KB，InnoDB 一页 16 KB）。查一行数据，最坏情况要把整张表的页都读一遍。索引是一个额外维护的有序结构，让你只读几页就能定位到目标行。

### 为什么是 B+ 树

| 结构 | 问题 |
|---|---|
| 哈希 | 只支持等值查询，不支持范围查询和排序 |
| 二叉搜索树 | 太高：10 亿行要 30 层，每层一次随机 IO |
| **B+ 树** | 一个节点就是一页，扇出几百；**内部节点只存 key**，扇出更大；**叶子节点用链表串起来**，范围扫描只需顺序读 |

扇出约 500 时，3 层能覆盖 $500^3 \approx 1.25 \times 10^8$ 行，4 层就是 600 亿行。根节点和上层节点基本常驻内存，所以一次点查实际只需要 1–2 次磁盘 IO。

### 聚簇索引和堆表

- **InnoDB**：主键索引就是数据本身（聚簇索引），二级索引的叶子存的是主键值，查完二级索引还要**回表**再查一次主键索引。所以主键要短、要单调递增（随机的 UUIDv4 主键会导致页分裂和写放大）。
- **PostgreSQL**：数据存在堆表里，所有索引都指向行的物理位置（ctid）。更新一行会写一个新版本，如果新版本不能在同一页做 HOT 更新，所有索引都要更新。

### 用好索引的规则

1. **最左前缀**：联合索引 `(a, b, c)` 能服务 `a`、`a,b`、`a,b,c` 的查询，不能直接服务只有 `b` 的查询。
2. **等值列在前，范围列在后**：`WHERE a = ? AND b > ?` 用 `(a, b)`；范围列后面的列在索引里就用不上了。
3. **索引同时服务 WHERE 和 ORDER BY**：DocPilot 的 `messages_conversation_idx (conversation_id, created_at)` 正好对应查询历史消息的 `WHERE conversation_id = ? ORDER BY created_at`，不需要额外排序。`UNIQUE (document_id, ord)` 除了是约束，也是一个索引，服务「按顺序取出某个文档的所有 chunk」。
4. **覆盖索引**：查询需要的列都在索引里时，不用回表（PostgreSQL 用 `INCLUDE`，并依赖 visibility map 实现 index-only scan）。
5. **让索引失效的写法**：对列套函数（`WHERE lower(email) = ?`，要建表达式索引）、隐式类型转换、前导通配符 `LIKE '%x'`、选择性很低的列（性别）。
6. **用 `EXPLAIN ANALYZE` 看真实的执行计划**，不要靠猜。

==索引不是越多越好==：每个索引都会让每次写入多一份维护成本，也占内存。

## 为什么需要事务：多步操作要么全成，要么全不成

### ACID 各靠什么实现

- **原子性 + 持久性**：**WAL**（预写日志）。修改数据页之前，先把变更顺序写进日志并 `fsync`，提交时只需要保证日志落盘。崩溃后重放日志（redo）。顺序写比随机写快得多，group commit 再把多个事务的 fsync 合并成一次。
- **隔离性**：**MVCC + 锁**。
- **一致性**：约束（主键、外键、唯一、CHECK）加上应用逻辑。

### 实战：DocPilot 的两个事务

```python
async with pool.connection() as conn, conn.transaction():
    INSERT conversations ... ON CONFLICT DO NOTHING
    INSERT messages (user)
    INSERT messages (assistant, created_at = clock_timestamp())
    INSERT traces
```

`store.save_turn` 把一轮对话的四条写入放在一个事务里：不会出现「有回答但没有 trace」或者「有 assistant 消息却没有 user 消息」的半截状态。

`ingest/pipeline.py` 的顺序同样值得注意：**先调用 embedding API 算出所有向量，再开事务**把 document 和所有 chunk 一次性写进去（`executemany`）。==事务里不要调用外部服务==：embedding API 可能要几秒，事务开着就一直占着连接，持有锁，还阻止 MVCC 清理旧版本。

### 一个隐蔽的坑：`now()` 在事务里是不变的

PostgreSQL 的 `now()`（也就是 `CURRENT_TIMESTAMP`）返回的是**事务开始的时间**，同一个事务里调用多少次都一样。所以在 `save_turn` 里，user 消息和 assistant 消息如果都用默认的 `now()`，`created_at` 会完全相同，`ORDER BY created_at` 的结果顺序就是不确定的，对话历史可能变成「先回答、后提问」。

DocPilot 的修法是 assistant 那一行显式写 `clock_timestamp()`，它返回语句执行时的真实时间（代码注释：so the assistant row sorts after the user row）。更稳妥的做法是加一个单调递增的序号列作为排序依据：时间戳可能相同，多个节点之间还有时钟偏差，**用时间戳做排序依据本身就不可靠**。

## 隔离级别与异常

| 级别 | 脏读 | 不可重复读 | 幻读 | 写偏斜 |
|---|---|---|---|---|
| Read Uncommitted | 可能 | 可能 | 可能 | 可能 |
| **Read Committed**（PostgreSQL 默认） | 无 | 可能 | 可能 | 可能 |
| **Repeatable Read**（MySQL 默认） | 无 | 无 | PostgreSQL 无；InnoDB 靠 next-key 锁基本避免 | **可能** |
| Serializable | 无 | 无 | 无 | 无 |

各种异常的含义：

- **脏读**：读到别的事务还没提交的数据。
- **不可重复读**：同一个事务里读同一行两次，结果不同。
- **幻读**：同一个范围查询两次，第二次多了几行。
- **写偏斜（write skew）**：两个事务各自读了同一组数据，根据读到的结果分别写了**不同的行**，单看每个事务都没问题，合起来违反了约束。经典例子：值班表要求至少一个医生在岗，两个医生同时查到「另一个人在岗」，于是都请了假。

### PostgreSQL 的实现

- **MVCC**：每一行有多个版本，用 `xmin` / `xmax` 标记由哪个事务创建、删除。读操作拿一个**快照**，只看快照可见的版本，读不阻塞写，写也不阻塞读。
- Read Committed：**每条语句**取一次快照；Repeatable Read：**整个事务**用同一个快照（即快照隔离，SI）。
- Serializable：在 SI 的基础上做 **SSI**（Serializable Snapshot Isolation），检测读写依赖形成的危险结构，发现后让其中一个事务失败，应用要重试。
- 代价：旧版本要靠 **VACUUM** 清理。长事务会让快照一直不释放，旧版本清不掉，表和索引就会膨胀（bloat）。

### 丢失更新：最常见的并发 bug

```
T1: SELECT balance → 100        T2: SELECT balance → 100
T1: UPDATE SET balance = 110    T2: UPDATE SET balance = 120   ← T1 的 +10 丢了
```

修法：

1. **原子更新**：`UPDATE accounts SET balance = balance + 10 WHERE id = ?`，最简单，优先用这个。
2. **悲观锁**：`SELECT ... FOR UPDATE` 锁住这一行，直到事务结束。
3. **乐观锁**：带上版本号 `UPDATE ... WHERE id = ? AND version = ?`，影响 0 行就重试（见[幂等](/backend/idempotency)）。
4. 用 Serializable 隔离级别，数据库检测到冲突后让其中一个失败。

## 连接与运维

- **PostgreSQL 是每个连接一个进程**，几千个连接就会把内存和调度压垮。应用端要用连接池（DocPilot 用 `psycopg_pool`，`max_size=10`），连接数多的话前面再加 PgBouncer。注意 PgBouncer 的事务池化模式会打破**连接级状态**：会话变量、`SET search_path`、某些用法下的 prepared statement 都会受影响。DocPilot 通过连接参数设置 `search_path`（为了让 eval 在独立的 schema 里运行），这种用法在事务池化下就要重新评估。
- **一个连接同一时刻只跑一条查询**（见[并发模型](/backend/concurrency-models)）。
- **原生 SQL 还是 ORM**：DocPilot 的 `db.py` 开头写着「用原生 SQL 而不是 ORM，这样每条查询都看得见、能 EXPLAIN」。ORM 的常见问题是隐式的 N+1 查询，以及看不出实际执行了什么 SQL。

## 追问

::: details 为什么数据库索引用 B+ 树，而不是哈希表或二叉树？
- 哈希只支持等值查询，不支持范围和排序。
- 二叉树太高，每层一次随机 IO。
- B+ 树一个节点就是一页，扇出几百，3–4 层就能覆盖上亿到上百亿行；内部节点只存 key，扇出更大；叶子节点用链表相连，范围扫描是顺序读。上层节点常驻内存，一次点查只需 1–2 次 IO。
:::

::: details 什么是最左前缀原则？什么是覆盖索引？
联合索引 `(a, b, c)` 按 a、b、c 的顺序排序，所以只能服务以 a 开头的条件。等值条件的列放前面，范围条件的列放后面，范围列之后的列在索引里用不上。

覆盖索引：查询需要的列全部在索引里，不用回表。InnoDB 省掉回主键索引那一步；PostgreSQL 靠 `INCLUDE` 和 visibility map 实现 index-only scan。
:::

::: details 四种隔离级别分别解决了什么问题？PostgreSQL 的 RR 和 MySQL 的 RR 一样吗？
RU 什么都不防；RC 防脏读；RR 再防不可重复读；Serializable 防所有异常，包括写偏斜。

PostgreSQL 的 RR 是快照隔离：整个事务用一个快照，没有幻读，但会有写偏斜。MySQL InnoDB 的 RR 在快照读之外，对当前读（`FOR UPDATE` / UPDATE）用 next-key 锁防幻读，两者的实现和边界情况不同。PostgreSQL 默认是 RC，MySQL 默认是 RR。
:::

::: details 什么是写偏斜？怎么避免？
两个事务读同一组数据，根据读到的结果分别写不同的行，各自看都合法，合起来违反了约束。例子：两个医生同时看到「还有一个人在岗」，都请了假。快照隔离防不住它，因为两个事务写的是不同的行，没有写写冲突。

避免办法：用 Serializable（PostgreSQL 的 SSI 会检测出来并让其中一个失败）；或者用 `SELECT ... FOR UPDATE` 锁住被读的那几行；或者把约束物化成某一行或某个唯一约束，让冲突变成写写冲突。
:::

::: details 一个并发「读-改-写」的场景丢了更新，有哪些修法？
1. 原子更新：`SET x = x + 1`，最好；
2. `SELECT ... FOR UPDATE` 悲观锁；
3. 版本号乐观锁，影响 0 行就重试；
4. Serializable 隔离级别，加上冲突重试。

选择上：能写成单条原子更新的就用原子更新；冲突少用乐观锁；冲突多、临界区短用悲观锁。
:::

::: details 为什么 DocPilot 写 assistant 消息时用 clock_timestamp() 而不是 now()？
PostgreSQL 的 `now()` 返回的是事务开始的时间，同一个事务里不变。user 和 assistant 消息在同一个事务里插入，用 `now()` 的话 `created_at` 完全相同，按时间排序的结果不确定。`clock_timestamp()` 返回语句执行时的真实时间。更稳妥的做法是加一个单调递增的序号列，因为时间戳可能相同，多个节点之间还有时钟偏差。
:::

::: details 为什么说长事务很危险？事务里能不能调用外部 API？
长事务会：一直占着连接，持有的行锁阻塞其他写入，旧快照让 VACUUM 清不掉旧版本，导致表膨胀，复制延迟也会变大。所以事务里不要调用外部 API。DocPilot 的 ingest 先调用 embedding API 算好所有向量，再开一个短事务把文档和 chunk 一次性写进去。如果外部调用必须和数据库写入保持一致，用 Outbox 模式（见 [Outbox 与事件驱动](/stack/mq-outbox)）。
:::

## 参考

- [PostgreSQL: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)、[Indexes](https://www.postgresql.org/docs/current/indexes.html)、[Current Date/Time（now 与 clock_timestamp）](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)
- Martin Kleppmann, *Designing Data-Intensive Applications*，第 3 章（存储与索引）、第 7 章（事务）
- Berenson et al., [A Critique of ANSI SQL Isolation Levels](https://arxiv.org/abs/cs/0701157)
- Ports & Grittner, [Serializable Snapshot Isolation in PostgreSQL](https://arxiv.org/abs/1208.4179)
- Markus Winand, [Use The Index, Luke](https://use-the-index-luke.com/)
- 实战代码：DocPilot `api/src/docpilot/schema.sql`、`store.py`（`save_turn`、`insert_document`）、`ingest/pipeline.py`、`db.py`
