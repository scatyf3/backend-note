import type { Card } from '@lib/flashcards'

const R = '/backend/concurrency-models'

export const cards: Card[] = [
  {
    id: 'conc-models-tradeoff',
    deck: 'backend',
    topic: '并发模型',
    q: 'OS 线程、事件循环 + 协程、M:N 调度（goroutine / virtual thread）三种并发模型各自的优缺点是什么？',
    a: '1. **OS 线程**：抢占式，一个任务写死循环也饿不死别人；但栈和内核结构贵，切换要进内核（1–5 µs），共享状态处处要加锁。\n2. **事件循环 + 协程**：协作式，一个协程只有几 KB，十万并发没压力，两次 `await` 之间天然原子；但**一个阻塞调用会卡住所有任务**。\n3. **M:N**：写法像同步代码，等待又便宜（goroutine 初始栈 2 KB），Go 1.14 起支持异步抢占；代价是运行时复杂，调用 C 库（cgo / JNI）时优势会打折。',
    ref: `${R}#三类模型`,
  },
  {
    id: 'conc-pool-size',
    deck: 'backend',
    topic: '线程池',
    q: '线程池应该开多大？给出公式，再用 Little\'s Law 估一个例子。',
    a: 'Goetz 公式：$N = N_{cores} \\times U \\times (1 + W/C)$，其中 W/C 是等待时间和计算时间之比。\n- CPU 密集：约等于核数。\n- IO 密集：比如 W/C = 9，8 核就开约 80 个线程。\n**Little\'s Law**：并发数 = 吞吐 × 平均占用时间。1000 QPS、每个请求占用线程 50 ms，就需要 **50** 个线程。\n最后还要看下游：DB 连接池只有 20 个的话，线程开再多也会堵在连接池上。',
    ref: `${R}#os-线程-抢占式-贵`,
  },
  {
    id: 'conc-gil',
    deck: 'backend',
    topic: 'Python',
    q: 'Python 有 GIL，多线程还有用吗？CPU 密集任务该怎么办？',
    a: '**IO 密集有用**：线程等 IO 时会释放 GIL，别的线程能继续跑。\n**CPU 密集纯 Python 没用**：同一时刻只有一个线程在执行字节码。\nCPU 密集要用 `ProcessPoolExecutor` / `multiprocessing`，或者交给会释放 GIL 的 C 扩展（numpy、大多数压缩和加密库）。free-threaded 构建（PEP 703）在 3.13 实验性提供、3.14 进入官方支持，但生产环境默认仍然按有 GIL 来设计。',
    ref: `${R}#python-的特殊情况-gil`,
  },
  {
    id: 'conc-coroutine-race',
    deck: 'backend',
    topic: '协程',
    q: '单线程的 asyncio 也会出竞态吗？举个例子，并说怎么修。',
    a: '**会**。单线程只保证两次 `await` 之间不被打断，**跨 `await` 的「检查再执行」**照样会竞态：\n`if key not in cache: cache[key] = await fetch(key)`：协程 A 在 `await` 时让出，B 也检查到没有，于是两个都去 fetch（缓存击穿的协程版本）。\n修法：用 `asyncio.Lock`，或者把正在进行的 Future 存起来，让后来的协程直接等它（**single-flight**）。',
    ref: `${R}#协程里同样有竞态`,
  },
  {
    id: 'conc-one-conn-one-query',
    deck: 'backend',
    topic: '连接池',
    q: 'DocPilot 混合检索用 `asyncio.gather` 同时跑向量查询和全文查询，为什么注释特别强调「separate pooled connections」？',
    a: '因为**一个 PostgreSQL 连接同一时刻只能执行一条查询**（协议在连接上是请求-响应串行的）。两个协程共用一个连接，要么被驱动串行化（白白失去并发），要么报错。\n`_vector` 和 `_fts` 各自 `async with pool.connection()` 借一个连接，延迟才能从两次查询之和降到较慢的那一次。\n附带一点：`max_size=10` 的连接池同时是**背压**，第 11 个借连接的协程会排队。',
    ref: `${R}#实战-docpilot-里的-asyncio-并发模式`,
  },
  {
    id: 'conc-gather-taskgroup',
    deck: 'backend',
    topic: 'asyncio',
    q: '`asyncio.gather` 和 `asyncio.TaskGroup` 在一个子任务抛异常时的行为有什么不同？DocPilot 的工具调用为什么选 gather？',
    a: '- **gather**：把第一个异常抛给调用方，但**其他任务不会被取消**，它们的结果也拿不到了（除非 `return_exceptions=True`）。\n- **TaskGroup**（3.11+）：结构化并发，一个失败就**取消所有兄弟任务**，最后抛出 `ExceptionGroup`。\nDocPilot 让 `Toolbox.run` 捕获所有异常并转成 `is_error=True` 的工具结果，所以 `gather` 永远不会抛异常，**模型能看到哪个工具失败了并自己决定怎么办**。需要「全有或全无」时才用 TaskGroup。',
    ref: `${R}#实战-docpilot-里的-asyncio-并发模式`,
  },
  {
    id: 'conc-cancel-baseexception',
    deck: 'backend',
    topic: '取消',
    q: '用户在 LLM 流式输出时关掉页面，为什么 DocPilot 的 `except Exception` 兜不住，导致这一轮不会被记录？',
    a: 'Starlette 会结束响应生成器：要么取消任务（`CancelledError`），要么在下一次 `yield` 时关闭生成器（`GeneratorExit`），取决于 ASGI 版本。这两个异常都继承自 **`BaseException`**，`except Exception` 抓不到，所以后面的 `save_turn` 不会执行：**token 花掉了，但没有 trace**。\n修法：在 `finally` 里用 `asyncio.shield` 保护写库操作，或者把 agent 的执行和 HTTP 连接解耦，改成后台任务。',
    ref: `${R}#实战-docpilot-里的-asyncio-并发模式`,
  },
  {
    id: 'conc-deadlock',
    deck: 'backend',
    topic: '锁',
    q: '死锁的四个必要条件是什么？工程上最常用的预防办法是哪个？',
    a: '**互斥、持有并等待、不可抢占、循环等待**，四个同时成立才会死锁。\n最常用：**固定全局加锁顺序**，破坏循环等待。其次是 `tryLock` 加超时后释放已持有的锁重试，以及缩小锁的范围（锁里不做 IO、不调外部回调）。\n数据库会自己检测死锁并回滚其中一个事务，应用层要准备好**重试**。',
    ref: `${R}#死锁`,
  },
]
