---
title: 并发模型：线程、事件循环与协程
status: draft
tags: [concurrency, asyncio, goroutine, lock]
difficulty: 3
order: 3
related: [/backend/os-io-models, /backend/network-tcp-http-tls, /ai/agent-loop]
stack: [f-concurrency]
---

# {{ $frontmatter.title }}

## 一句话结论

选并发模型，本质上是在回答两个问题：==一个正在等待的任务要占用多少资源，以及什么时候切换由谁说了算==。OS 线程是抢占式的，但很贵；事件循环 + 协程是协作式的，很便宜，但一个任务阻塞就会卡住所有任务；Go 的 goroutine 和 Java 21 的 virtual thread 是 M:N 调度，便宜而且（基本上）是抢占式的。不管选哪种，**共享可变状态**都要单独处理：用锁、原子操作，或者干脆不共享，改用消息传递。

## 为什么：先分清并发和并行，IO 密集和 CPU 密集

### 概念：并发 vs 并行

- **并发（concurrency）**：同一段时间内有多个任务**都在推进**，可以在一个核上交替执行。
- **并行（parallelism）**：同一时刻有多个任务**真的同时在跑**，需要多个核。

打个比方：一个厨师看三口锅，A 在炖就去切 B 的菜，再回头搅 C，三道菜都在推进，但任何一刻他手上只做一件事，这是**并发**；三个厨师一人一口锅同时动手，这是**并行**。

```
并发（1 个核）：  A A B C A B C B A …   ← 一个核轮流切换
并行（3 个核）：  核1: A A A A A
                 核2: B B B B B
                 核3: C C C C C        ← 同一时刻真的一起跑
```

==并发是程序的结构（同时有几件事在进行），并行是执行的方式（同时有几个核在干活）。==判断方法：假设机器只有 1 个核，这个手段还有用吗？有用 → 它解决的是并发；没用 → 它解决的是并行。

什么时候需要哪个，取决于负载：

- **IO 密集**：一个请求 95% 的时间在等 DB、等下游、等 LLM 吐字。等的时候 CPU 是闲的，就像锅在炖、厨师没事干。只要「等的时候让出来去干别的」，一个核就能照顾成千上万个请求。要的是**并发**，关键是让等待便宜。后端服务绝大多数是这一类。
- **CPU 密集**：解析 PDF、算 embedding、压缩。活本身就占满 CPU，一个核切换得再快也不会变快，要的是**并行**，也就是多个核。

### 实现：哪些机制提供并发，哪些提供并行

| 机制 | 并发 | 并行 | 说明 |
|---|---|---|---|
| 事件循环（Node.js、asyncio、单 worker 的 nginx） | ✓ | ✗ | 只有一个线程，靠「等的时候切走」照顾很多任务 |
| 无栈协程 `async` / `await` | ✓ | ✗ | 跑在事件循环上，同样是单线程 |
| Python 多线程 | ✓ | ✗ | GIL 让同一时刻只有一个线程执行 Python 字节码，见下文「Python 的特殊情况：GIL」 |
| OS 线程（Java / Go / C++） | ✓ | ✓ | 内核把线程分到不同核上 |
| goroutine、Java virtual thread | ✓ | ✓ | M:N 调度，大量轻量任务铺到「核数个」OS 线程上 |
| 多进程（multiprocessing、gunicorn 多 worker） | ✓ | ✓ | 每个进程独立跑在一个核上，常用来绕开 GIL |

一个机制往往两样都能给，选它的**理由**才是关键。比如 virtual thread 也能并行，但大家选它是因为它让「等待」很便宜；进程池也能并发，但大家选它是为了拿到多核。

所以选模型的顺序是：

1. 负载以 IO 为主 → 要的是**并发**，让等待便宜 → 事件循环 / 协程 / goroutine / virtual thread。
2. 有 CPU 密集的部分 → 要的是**并行**，用上多核 → 线程池（无 GIL 的语言）、进程池，或者拆到单独的 worker。

## 三类模型

### OS 线程：抢占式，贵

内核调度，时间片用完就被强制切走，所以一个线程写了死循环，不会饿死其他线程。代价：

- 每个线程有自己的栈（Linux 默认预留 8 MB 虚拟地址）和内核数据结构；
- 切换要进内核，1–5 µs 外加 cache 失效；
- 抢占可能发生在**任意两条指令之间**，所以所有共享状态都要加锁。

线程池大小有个经典公式（Brian Goetz，《Java Concurrency in Practice》）：

$$N_{threads} = N_{cores} \times U_{target} \times \left(1 + \frac{W}{C}\right)$$

其中 $W/C$ 是等待时间和计算时间之比。CPU 密集（$W/C \approx 0$）时线程数约等于核数；IO 密集时，比如等待是计算的 9 倍，8 核机器大约开 80 个线程。

### 事件循环 + 协程：协作式，便宜

一个线程跑事件循环，任务只在 `await` 的地方**主动让出**控制权（见 [OS 与 IO 模型](/backend/os-io-models)）。

- **便宜**：一个协程只是堆上的一个状态机对象，几 KB。十万个并发连接没压力。
- **两次 `await` 之间不会被打断**：单线程事件循环里，不跨 `await` 的代码天然是原子的，很多场景不用加锁。
- **致命弱点**：只要有一个任务不让出（阻塞调用、CPU 密集循环），所有任务都会卡住。

实现上分两种：

- **无栈协程（stackless）**：Python `async/await`、JavaScript、Rust、C#。编译器把函数改写成状态机，只能在 `async` 函数里 `await`。
- **有栈协程（stackful）**：Go goroutine、Java virtual thread、Lua。每个协程有自己的（可增长的）栈，任意深度的函数调用里都能挂起。

无栈协程带来一个问题，叫 **function coloring**：`async` 函数只能被 `async` 函数调用，一个底层函数改成 async，整条调用链都要跟着改。有栈协程没有这个问题，所以 Go 程序员写的是看起来同步的代码。

### M:N 调度：goroutine 和 virtual thread

把 M 个用户态任务调度到 N 个 OS 线程上（N ≈ 核数）：

- **Go**：GMP 模型。G 是 goroutine，初始栈 2 KB，按需增长；M 是 OS 线程；P 是逻辑处理器，持有本地运行队列，空闲时会去别的 P 偷任务（work stealing）。goroutine 碰到阻塞的系统调用时，M 和 P 分离，P 换一个 M 继续跑别的 G。Go 1.14 起支持**基于信号的异步抢占**，一个死循环的 goroutine 也不会饿死别人。
- **Java 21 virtual thread**（JEP 444）：写法和普通线程一样，阻塞时 JVM 把它从载体线程上卸下来。早期有个坑是 `synchronized` 块里阻塞会 **pin** 住载体线程，JDK 24（JEP 491）基本修好了。

==M:N 模型同时拿到了「写起来像同步代码」和「等待很便宜」==，代价是运行时变复杂，并且和 C 库交互（cgo、JNI）时会损失一部分优势。

### Python 的特殊情况：GIL

CPython 有全局解释器锁（GIL），同一时刻只有一个线程在执行 Python 字节码。所以：

- Python 线程能并发处理 IO（等 IO 时会释放 GIL），但**不能并行算 Python 代码**。
- CPU 密集任务要用 `multiprocessing` / `ProcessPoolExecutor`，或者交给会释放 GIL 的 C 扩展（numpy、大部分压缩和加密库）。
- PEP 703 的 free-threaded 构建在 3.13 以实验形式提供，3.14 起进入官方支持阶段（PEP 779），但生态还在迁移中，生产环境默认仍然要按有 GIL 来设计。

## 共享状态：并发 bug 的来源

### 竞态与锁

`count += 1` 不是原子的，它是「读、加、写」三步，两个线程交错执行就会丢更新。保护手段从重到轻：

1. **互斥锁（mutex）**：同一时刻只允许一个持有者。
2. **读写锁**：读多写少时允许并发读。
3. **原子操作 / CAS**：无锁地做「比较并交换」，适合计数器、指针交换。要注意 ABA 问题：值从 A 变成 B 又变回 A，CAS 会误以为没被改过，常用版本号解决。
4. **不共享**：每个任务持有自己的数据，通过 channel 或队列传消息。Go 的口号是「不要通过共享内存来通信，而要通过通信来共享内存」。

### 死锁

四个必要条件同时成立才会死锁：互斥、持有并等待、不可抢占、循环等待。工程上最常用的预防办法是**破坏循环等待**：所有代码按同一个全局顺序加锁。其次是加锁超时（`tryLock`），超时后释放已持有的锁再重试。

### 协程里同样有竞态

单线程事件循环只保证两次 `await` 之间不被打断，**跨 `await` 的「检查然后执行」照样会出竞态**：

```python
if key not in cache:              # 协程 A 检查：没有
    cache[key] = await fetch(key)  # A 在这里让出；协程 B 也检查：没有 → 两个都去 fetch
```

这就是缓存击穿的协程版本，要用 `asyncio.Lock`，或者存一个 in-flight 的 Future 让后来者等待（single-flight），见[缓存](/stack/st-cache)。

## 实战：DocPilot 里的 asyncio 并发模式

DocPilot 的 API 全是 asyncio，下面几个用法各对应一个知识点。

**1. 两个独立查询并发执行，但必须用两个连接。** `retrieval/search.py` 的混合检索：

```python
# Two independent queries on separate pooled connections: run them concurrently.
vec, fts = await asyncio.gather(self._vector(query, n), self._fts(query, n))
```

注释里的「separate pooled connections」是关键：==一个 DB 连接同一时刻只能执行一条查询==（PostgreSQL 协议在一个连接上是串行的），两个协程共用一个连接，要么报错，要么被驱动串行化。`_vector` 和 `_fts` 各自 `async with pool.connection()`，所以真的是并发的，延迟从两次查询之和降到较慢的那一次。

**2. 连接池就是并发上限。** `db.py` 里 `max_size=10`。一个 worker 上同时进行的混合检索最多 5 个（每个占两个连接），第 11 个借连接的协程会排队等待。连接池在这里同时是性能资源和**背压（backpressure）机制**，见[容量估算](/stack/arch-capacity)。

**3. 用 Semaphore 限制对外并发。** `evals/run.py` 用 `asyncio.Semaphore(args.concurrency)`（默认 4）包住每个问题的请求，再用 `gather` 一起发。不加信号量的话，110 个问题会同时打到 LLM 供应商，立刻触发 429。

**4. 同一轮的工具调用并发执行，并且不让一个失败拖垮全部。** `agent/loop.py`：

```python
outcomes = await asyncio.gather(*(toolbox.run(c) for c in turn.tool_calls))
```

`gather` 默认的行为是：一个任务抛异常，`gather` 立即把异常抛出来，**其他任务不会被取消**，它们的结果也拿不到了。DocPilot 的处理是让 `Toolbox.run` 捕获所有异常，转成 `is_error=True` 的工具结果返回给模型，所以 `gather` 永远不会抛异常，模型能看到哪个工具失败了并且自己决定怎么办。另一种写法是 Python 3.11 的 `asyncio.TaskGroup`（结构化并发）：一个子任务失败会**取消**其他兄弟任务，适合「要么全成功，要么全放弃」的场景。

**5. 取消也是并发的一部分。** 用户在流式输出过程中关掉页面，Starlette 会结束正在执行的响应生成器。具体方式取决于服务器声明的 ASGI 版本：要么取消任务（在当前 `await` 点抛 `CancelledError`），要么在下一次 `yield` 时关闭生成器（抛 `GeneratorExit`）。这两个异常都继承自 `BaseException`，DocPilot `routes/chat.py` 里的 `except Exception` 接不住，所以后面的 `save_turn` 不会执行：这一轮已经花掉的 token 没有 trace 记录。如果要「断开连接也记账」，需要在 `finally` 里用 `asyncio.shield` 保护写库操作，或者把 agent 的执行和 HTTP 连接解耦（见[长任务与 human-in-the-loop](/stack/ag-durable)）。

## 追问

::: details 并发和并行的区别？举一个有并发没并行的例子。
并发是多个任务在同一段时间内交替推进，并行是同一时刻真正同时执行。单线程的 Node.js 或 asyncio 服务器同时处理上万个连接，就是有并发、没并行：一个核在多个连接之间切换，靠的是任务大部分时间在等 IO。
:::

::: details Python 有 GIL，那多线程还有用吗？
对 IO 密集的任务有用：线程在等 IO 时会释放 GIL，别的线程可以继续执行。对 CPU 密集的纯 Python 代码没用，同一时刻只有一个线程在跑字节码。CPU 密集要用多进程，或者用会释放 GIL 的 C 扩展（numpy）。3.13 起有可选的 free-threaded 构建，但生态还没完全跟上。
:::

::: details 线程池开多大合适？
看负载类型：

- CPU 密集：约等于核数（再多只会增加切换开销）。
- IO 密集：核数 × (1 + 等待时间 / 计算时间)。

更实际的做法是用 Little's Law 反推：并发数 = 吞吐 × 平均延迟。比如目标是 1000 QPS，每个请求平均占用线程 50 ms，就需要 50 个线程。最后一定要压测验证，并且盯住下游的承受能力：线程池再大，DB 连接池只有 20 个也没用。
:::

::: details goroutine 为什么比线程便宜？
1. **栈小且可增长**：初始 2 KB，按需扩容；OS 线程固定预留 MB 级别。
2. **用户态调度**：切换不进内核，只保存少量寄存器。
3. **M:N 复用**：上万个 goroutine 跑在核数个 OS 线程上，阻塞的系统调用由运行时把 P 交给别的线程。

所以 Go 里可以随手为每个连接、每个请求开一个 goroutine。
:::

::: details 死锁的四个必要条件是什么？工程上怎么避免？
互斥、持有并等待、不可抢占、循环等待。工程上最常用的是**固定加锁顺序**（破坏循环等待），其次是**加锁超时**后回退重试，以及**缩小锁的范围**：锁里不做 IO，不调用外部回调。数据库里的死锁由数据库检测，然后回滚其中一个事务，应用层要准备好重试。
:::

::: details asyncio.gather 和 TaskGroup 有什么区别？
- `gather`：一个任务抛异常时，`gather` 立刻把异常抛给调用方，但**其他任务继续执行**，也不会被取消；加上 `return_exceptions=True` 则会把异常当结果收集起来。
- `TaskGroup`（3.11+）：结构化并发，一个子任务失败会**取消所有兄弟任务**，退出 `async with` 时把异常打包成 `ExceptionGroup` 抛出。

需要「部分失败也继续，并且把失败告诉上游」时，像 DocPilot 那样在任务内部捕获异常、转成错误结果更清楚；需要「全有或全无」时用 TaskGroup。
:::

::: details 为什么不能让多个协程共用同一个数据库连接并发查询？
PostgreSQL 的协议在一个连接上是请求-响应串行的，一个连接同一时刻只能有一条查询在执行。多个协程共用一个连接，要么被驱动排队串行化（白白失去并发），要么在协议层交错导致报错。正确的做法是每个并发查询从连接池里各借一个连接，DocPilot 的混合检索就是这样做的。另外要注意，事务是绑定在连接上的，同一个事务里的语句必须走同一个连接。
:::

## 参考

- Brian Goetz et al., *Java Concurrency in Practice*，第 8 章「Applying Thread Pools」
- [Go scheduler 设计文档（Dmitry Vyukov）](https://golang.org/s/go11sched)、[Go 1.14 release notes：异步抢占](https://go.dev/doc/go1.14#runtime)
- [JEP 444: Virtual Threads](https://openjdk.org/jeps/444)、[JEP 491: Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491)
- [PEP 703: Making the GIL Optional](https://peps.python.org/pep-0703/)、[PEP 779](https://peps.python.org/pep-0779/)
- Bob Nystrom, [What Color is Your Function?](https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/)
- [Python asyncio: Task Groups](https://docs.python.org/3/library/asyncio-task.html#task-groups)
- 实战代码：DocPilot `api/src/docpilot/retrieval/search.py`、`agent/loop.py`、`agent/tools.py`、`routes/chat.py`、`evals/run.py`
