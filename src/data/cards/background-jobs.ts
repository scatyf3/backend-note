import type { Card } from '@lib/flashcards'

const R = '/backend/background-jobs'

export const cards: Card[] = [
  {
    id: 'jobs-when',
    deck: 'backend',
    topic: '后台任务',
    q: '什么样的工作应该从请求路径里移到后台任务？为什么？',
    a: '耗时超过几百毫秒的、依赖外部服务（可能失败要重试）的、CPU 密集的、可批量的、定时执行的、用户不需要立即拿到结果的工作。\n原因：\n1. 请求有超时（LB、网关、浏览器）；\n2. CPU 密集的工作会**阻塞事件循环**，拖慢同一个进程上的所有请求；\n3. 在请求里重试只会让用户等更久；\n4. 批量上传时，同步处理就是一堆同时运行的重活。',
    ref: `${R}#为什么不在请求里做完`,
  },
  {
    id: 'jobs-lease',
    deck: 'backend',
    topic: '可靠性',
    q: '后台任务系统怎么保证任务不丢、也不会因为 worker 崩溃而永远卡住？带来什么后果？',
    a: 'worker 领取任务时**加租约**（可见性超时），而不是删除任务；完成后才删除或标记完成。\n- worker 崩溃：租约过期，任务回到队列被别人领走；\n- 长任务：定期**续约**（心跳）。\n**后果**：任务可能被执行不止一次（at-least-once），所以处理逻辑**必须幂等**。再配上最大重试次数和死信队列，防止坏任务无限重试。',
    ref: `${R}#租约-lease-可见性超时`,
  },
  {
    id: 'jobs-skip-locked',
    deck: 'backend',
    topic: 'PostgreSQL 队列',
    q: '怎么用 PostgreSQL 实现任务队列？`FOR UPDATE SKIP LOCKED` 起什么作用？有什么好处和限制？',
    a: '一张 jobs 表，worker 用 `SELECT id ... FOR UPDATE SKIP LOCKED LIMIT 1` 选出一个可执行的任务，在同一条 UPDATE 里改成 running 并写上租约到期时间。\n**SKIP LOCKED**：被别人锁住的行直接跳过，并发的 worker **不会互相等待，也不会领到同一个任务**。\n**好处**：入队能和业务写入在**同一个事务**里；少一个系统；能用 SQL 直接查任务状态。\n**限制**：吞吐有限；频繁更新产生死元组，需要关注 VACUUM。',
    ref: `${R}#用-postgresql-做任务队列`,
  },
  {
    id: 'jobs-error-classes',
    deck: 'backend',
    topic: '重试',
    q: '后台任务失败时，怎么决定重试还是放弃？死信队列有什么用？',
    a: '**区分错误类型**：429、5xx、超时是**临时错误**，按指数退避加抖动重试；参数错误、文件损坏是**永久错误**，重试多少次都没用，直接标记失败并记录原因。\n设置**最大尝试次数**和**执行超时**。\n**死信队列**：超过最大次数仍失败的任务移进去并告警，保留现场，排查修复后可以**重放**，同时避免一个坏任务一直占着 worker。',
    ref: `${R}#重试和死信`,
  },
  {
    id: 'jobs-shared-limiter',
    deck: 'backend',
    topic: '限速',
    q: '100 个 worker 同时调用 LLM / embedding API，怎么避免集体触发 429？为什么单进程的 Semaphore 不够？',
    a: 'Semaphore 只限制**一个进程内**的并发，100 个 worker 进程各有各的 Semaphore，加起来还是会超限。\n需要**所有 worker 共享**的限速器：\n1. Redis 实现的分布式令牌桶，同时限制 **RPM 和 TPM**，检查和扣减用 Lua 脚本保证原子（LLMGateway 的做法）；\n2. 或者让所有 worker 都**通过 LLM 网关**调用，由网关统一限速。\n收到 429 时按 `Retry-After` 退避。',
    ref: `${R}#对下游限速`,
  },
  {
    id: 'jobs-fairness-cron',
    deck: 'backend',
    topic: '调度',
    q: '一个大客户提交了一万个任务，堵住了其他客户，怎么办？定时任务部署了 3 个实例，怎么保证每次只执行一次？',
    a: '**租户公平**：每个租户一个逻辑队列，worker 轮询各个租户；限制每个租户同时运行的任务数；小任务走高优先级队列；按租户监控「最老任务的等待时间」。\n**定时任务只执行一次**：\n1. 选主，只有 leader 负责调度；\n2. 用「任务名 + 计划时间」做唯一键入队，靠唯一约束去重；\n3. 交给外部调度器（K8s CronJob）。\n还要决定停机期间错过的执行是否补跑。',
    ref: `${R}#租户之间的公平`,
  },
  {
    id: 'jobs-docpilot-ingest',
    deck: 'backend',
    topic: '实战',
    q: '把 DocPilot 同步的文档入库改造成后台任务，关键步骤是什么？怎么保证任务可以安全地重复执行？',
    a: '1. `POST /documents`：存原始文件，在**同一个事务**里插入 `documents(status=processing)` 和入库任务，返回 **202**；\n2. worker：解析、切分 → 通过**共享限速器**分批调用 embedding；\n3. **在一个事务里先删除这个文档已有的 chunk 再插入新的**，状态改为 ready，这样重复执行是**幂等**的；\n4. 区分可重试错误和永久错误，失败原因写回状态；\n5. 前端轮询或订阅状态。\n代价：上传后不能立刻拿到结果，小文件可以保留同步的快速路径。',
    ref: `${R}#实战-把-docpilot-的入库改成后台任务`,
  },
]
