---
title: OS 与 IO 模型：从阻塞到 epoll / IOCP / io_uring
status: draft
tags: [io, epoll, event-loop, asyncio]
difficulty: 3
order: 2
related: [/backend/network-tcp-http-tls, /backend/concurrency-models]
stack: [f-os-io]
---

# {{ $frontmatter.title }}

## motivation/high level idea

这里的问题是我们有很多链接（等待），但这些链接只有在很少的时候在io。最naive的做法是
```python
# ① naive：一个连接一个线程，线程大部分时间卡在 read() 上
def handle(conn):
    while True:
        req = conn.read()          # 阻塞：没数据就一直等
        conn.send(process(req))

for conn in accept_all():
    Thread(target=handle, args=(conn,)).start()   # 1 万个连接 = 1 万个线程
```

但是大部分时间都在空等，最好的做法是解耦，每个thread都把自己的read请求委托给内核对应的功能（不能委托给用户态的线程），这样，一个线程处理把a request处理完之后就能处理b，相当于overlap计算和io。
```python
# ② 委托：把「等数据 + 读」交给别人，读完再通知我
#    （Proactor：IOCP / io_uring，内核就是那个「专门读的线程」）
for conn in conns:
    submit_read(conn, buf=alloc())   # 立即返回，buf 先押给内核
while True:
    conn, buf = wait_completion()    # 谁读完了就处理谁
    conn.send(process(buf))
    submit_read(conn, buf)           # 挂上下一次读

# ③ 网络上更常见：一个线程问内核「谁有数据了」，只读那几个
#    （Reactor：epoll / kqueue，nginx、Redis、Node.js）
for conn in conns:
    conn.setblocking(False)
    epoll.register(conn, EPOLLIN)
while True:
    for conn in epoll.wait():        # 阻塞在这里，但一次等所有连接
        req = conn.read()            # 数据已在内核缓冲区，读不会卡
        conn.send(process(req))
```

当然，实际写代码时我们连 epoll / IOCP 这些系统调用都不用直接碰：「替你等」的能力内核已经提供了，**事件循环库**再把它包一层，按平台自动选后端（Linux 用 epoll，macOS 用 kqueue，Windows 用 IOCP）：

- C：libuv、libevent
- Node.js：底下就是 libuv
- Python：asyncio（`async` / `await`）
- Java：Netty
- Rust：tokio
- Go 更彻底：goroutine 里直接写看起来阻塞的 `conn.Read()`，runtime 的 netpoller 在底下用 epoll 把它变成非阻塞，连事件循环都看不见。

## 一句话结论

高并发服务器的核心是==不让线程空等 IO==。一个连接配一个阻塞线程，撑不住上万个大多数时间都在空闲的连接，所以出现了**非阻塞 socket + IO 多路复用（epoll / kqueue）+ 事件循环**。这套机制是 **readiness 模型**：内核告诉你「可以读了」，读还得你自己去读。Windows 的 IOCP 和 Linux 的 io_uring 属于 **completion 模型**：你把读请求交给内核，内核读完再通知你。两种模型的差别决定了 Reactor 和 Proactor 两种架构，也是一些库在 Windows 上跑不起来的原因。

## 为什么：线程很贵，连接大多数时候在空等

一个后端服务典型的连接画像是：几万个长连接（HTTP keep-alive、WebSocket、SSE、DB 连接池），任意时刻只有一小部分有数据可读。

如果每个连接配一个线程，并且阻塞在 `read()` 上：

- **内存**：Linux 线程栈默认预留 8 MB 虚拟地址（`ulimit -s`），实际按需分配，但每个线程还有内核栈和 task_struct。1 万个线程光元数据就是几十到上百 MB。
- **调度**：一次上下文切换直接开销 1–5 µs，再加上 TLB 和 cache 被冲掉的间接成本。线程数远超核数时，CPU 时间大量花在切换上。
- **结果**：这就是 1999 年 Dan Kegel 提出的 **C10K 问题**。

所以思路反过来：**少量线程（甚至一个）管理大量连接，只在连接真的有数据时才去处理它**。这需要两样东西：

1. socket 设成**非阻塞**：没数据时 `read()` 立即返回 `EAGAIN`，不会卡住线程。
2. 有一个系统调用能**一次等待很多 fd**，告诉你哪些就绪了。这就是 IO 多路复用。

## 五种 IO 模型

Stevens 在 UNP 里的分类，面试常问：

| 模型 | 等数据就绪 | 数据从内核拷到用户空间 |
|---|---|---|
| 阻塞 IO | 阻塞 | 阻塞 |
| 非阻塞 IO | 轮询（忙等） | 阻塞 |
| IO 多路复用（select/poll/epoll） | 阻塞在 `epoll_wait` 上，一次等很多 fd | 阻塞 |
| 信号驱动 IO | 内核发信号通知 | 阻塞 |
| 异步 IO（IOCP、io_uring、POSIX AIO） | 不阻塞 | **也不阻塞**，内核拷完再通知 |

![五种 IO 模型对比：横轴是时间，分「等数据就绪」和「内核拷到用户空间」两个阶段；前四种在第二阶段都阻塞，所以是同步 IO，只有异步 IO 两个阶段都不阻塞](/diagrams/io-models.svg)

关键在最后一列：==前四种都是同步 IO，因为拷贝那一步还得应用线程自己做==。只有最后一种是真正的异步 IO。「阻塞 / 非阻塞」说的是调用会不会卡住，「同步 / 异步」说的是谁来完成数据拷贝，两组概念要分清。

## select → poll → epoll

| | select | poll | epoll |
|---|---|---|---|
| fd 上限 | `FD_SETSIZE` = 1024 | 无 | 无 |
| 每次调用 | 把整个 fd 集合拷进内核 | 同 select | 只调用 `epoll_wait`；fd 用 `epoll_ctl` 注册一次即可 |
| 找就绪 fd | O(n) 扫一遍 | O(n) | O(就绪数)：内核维护就绪链表，回调时把 fd 挂上去 |
| 返回后 | 用户再扫一遍 fd_set | 再扫一遍 | 直接拿到就绪列表 |

![select、poll、epoll 一次调用的开销对比：select 和 poll 每次把整组 fd 拷进内核、内核 O(n) 扫描、整组拷回、用户再 O(n) 扫描；epoll 用 epoll_ctl 注册一次，数据到达时回调把 fd 挂进就绪链表，epoll_wait 只拷回 k 个就绪 fd](/diagrams/select-poll-epoll.svg)

10 万个连接里只有 100 个活跃时，select/poll 每轮要扫 10 万个，epoll 只处理 100 个。这就是 epoll 能撑起 nginx、Redis、Node.js 的原因。BSD/macOS 上的对应物是 kqueue。

### LT 和 ET

- **水平触发（LT，默认）**：只要缓冲区里还有数据，每次 `epoll_wait` 都会报告这个 fd。编程简单，不怕漏读。
- **边缘触发（ET）**：只在状态**变化**时（从没数据变成有数据）报告一次。必须**一直读到 `EAGAIN`** 为止，否则剩下的数据不会再触发通知，连接就「卡死」了。好处是减少重复唤醒，nginx 用的就是 ET。

### 惊群

多个进程或线程 `epoll_wait` 同一个监听 socket，一个新连接到来时全被唤醒，最后只有一个能 `accept` 到。解决办法是 `EPOLLEXCLUSIVE`（Linux 4.5+），或者 `SO_REUSEPORT` 让每个 worker 有自己的监听 socket，由内核按哈希分配连接。

## Reactor 和 Proactor

- **Reactor**（基于 readiness）：事件循环等「可读」事件，然后回调里自己调 `read()`。nginx、Redis、Node.js（libuv 在 Linux 上）、Python asyncio 的 `SelectorEventLoop`、Netty 都是这种。
- **Proactor**（基于 completion）：先提交「读到这个 buffer」的请求，内核读完后，事件循环拿到「读完了」的事件。Windows IOCP、Linux io_uring、asyncio 的 `ProactorEventLoop`、Boost.Asio 都是这种。

![Reactor 与 Proactor 时序对比：Reactor 收到「可读了」事件后，应用线程自己调 read，卡在拷贝上；Proactor 提交读请求时就把 buf 交给内核，内核等数据并拷进 buf，完成后事件循环把带着数据的 buf 交给 handler](/diagrams/reactor-proactor.svg)

两者对上层代码的影响是：Reactor 下库可以拿到原始 fd，自己决定什么时候读；Proactor 下必须预先给出 buffer，把操作交给内核。**一个按 Reactor 写的库，在只有 Proactor 的事件循环上会跑不起来。**

## 实战：DocPilot 在 Windows 上为什么要换事件循环

DocPilot 的 README 里有这样一句：Windows 下不用 `--reload` 时，要给 uvicorn 加上 `--loop asyncio:SelectorEventLoop`，因为 psycopg 的 async 驱动需要它。`api/src/docpilot/cli.py` 里也专门写了：

```python
def run_async(coro):
    """psycopg's async driver needs a selector event loop, which is not Windows' default."""
    if sys.platform == "win32":
        return asyncio.run(coro, loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(coro)
```

背后的链条：

1. Python 3.8 起，Windows 上 asyncio 的默认事件循环改成了 `ProactorEventLoop`（基于 IOCP），因为它支持子进程和管道，而 `SelectorEventLoop` 在 Windows 上只能用 `select()`，只支持 socket。
2. psycopg 3 的异步模式要拿到 libpq 连接的 socket fd，等它可读或可写，再调 libpq 的非阻塞函数。这是典型的 **Reactor 用法**，依赖 `loop.add_reader()`。
3. `ProactorEventLoop` 不实现 `add_reader()`，所以 psycopg 文档明确说 Windows 上不能用默认事件循环。

教训是：==「async」不是一种东西==，同样是 asyncio，底下可能是 readiness 也可能是 completion。跨平台出问题的时候，先查库依赖哪种语义。

## 事件循环最大的坑：在 async 函数里做阻塞操作

事件循环是单线程的。任何一个回调里执行阻塞调用（同步 HTTP 请求、`time.sleep`、CPU 密集计算、同步 DB 驱动），**所有其他连接都会一起卡住**。

DocPilot 里就有一个现成的例子：`routes/documents.py` 的上传接口是 `async def`，但它调用的 `parse_document`（解析 PDF / HTML）和 `chunk_text` 是同步的 CPU 密集代码。上传一个 20 MB 的 PDF，解析期间同一个 worker 上所有正在流式输出的聊天都会停住，等解析结束才继续吐字。修法有两种：

- `await asyncio.to_thread(parse_document, filename, data)`，把它丢进线程池。
- 进一步把整个 ingest 做成[后台任务](/stack/mq-jobs)，上传接口立即返回 202。

FastAPI 的规则也值得记住：路由函数写成普通 `def` 时，FastAPI 会自动把它放进线程池（anyio，默认 40 个线程）里执行；写成 `async def`，就默认你保证里面不会阻塞。==写 `async def` 却调用同步库，比直接写 `def` 还糟。==

## 文件 IO 和零拷贝

- **普通文件不能用 epoll**：对普通文件调 `epoll_ctl` 会返回 `EPERM`，select/poll 则永远报告「就绪」。因为磁盘读取在概念上总是能「进行」的，只是慢。所以 libuv 用线程池做文件 IO（`UV_THREADPOOL_SIZE` 默认是 4），asyncio 的 `aiofiles` 底下也是线程。
- **io_uring**（Linux 5.1+）：用户态和内核之间共享两个环形队列（提交队列 SQ、完成队列 CQ），批量提交、批量收割，系统调用次数大幅下降，而且对文件和网络都是真异步。代价是 API 复杂，而且出过不少安全漏洞，部分云厂商和容器运行时默认禁用了它。
- **零拷贝**：`sendfile()` 让数据直接从 page cache 进 socket 缓冲区，跳过用户态，nginx 发静态文件、Kafka 消费者读日志都靠它。`mmap` 把文件映射进地址空间，省一次拷贝，但缺页中断有成本。
- **page cache 与 fsync**：`write()` 返回只代表数据进了 page cache，掉电会丢；要持久化必须 `fsync`。数据库 WAL 的提交延迟主要就花在这里，见[索引、事务与隔离级别](/stack/st-sql)。

## 追问

::: details epoll 为什么比 select 快？
三点：

1. **注册与等待分离**：fd 用 `epoll_ctl` 注册一次，内核用红黑树保存；select 每次调用都要把整个 fd_set 拷进内核。
2. **就绪通知靠回调**：网卡收到数据时，内核回调把 fd 挂到就绪链表上，`epoll_wait` 只返回这个链表，复杂度是 O(就绪数)，select 是 O(总数)。
3. **没有 1024 上限**。

在连接很多、活跃很少的场景差距最明显。如果所有 fd 都很活跃，差距会缩小。
:::

::: details ET 模式下为什么必须读到 EAGAIN？
ET 只在缓冲区「从空变非空」时通知一次。如果这次只读了一部分，剩下的数据不会再触发通知（除非又来了新数据），这个连接就挂起了。所以 ET 必须配合非阻塞 socket，在循环里一直读到返回 `EAGAIN`。写也是一样。
:::

::: details Redis 是单线程的，为什么还这么快？
1. 纯内存操作，单个命令通常在微秒级完成。
2. epoll 事件循环，一个线程就能管上万个连接。
3. 单线程不用加锁，没有上下文切换，数据结构可以写得很简单。

瓶颈通常在网络 IO 和协议解析，而不在 CPU，所以 Redis 6.0 加了 IO threads，只把读写 socket 和解析协议并行化，命令执行仍然是单线程，原子性保证不变。代价是：一个慢命令（`KEYS *`、大 key 的 `DEL`）会阻塞所有客户端。
:::

::: details Reactor 和 Proactor 有什么区别？各举一个例子。
- Reactor：事件循环通知「fd 可读」，应用自己调 `read`。例子：nginx、Redis、Netty、asyncio 的 `SelectorEventLoop`。
- Proactor：应用提交「读到 buffer」的请求，内核完成后通知「读完了」。例子：Windows IOCP、io_uring、asyncio 的 `ProactorEventLoop`。

实际影响：依赖 `add_reader` 这类 readiness 接口的库（比如 psycopg 3 async）在 Proactor 循环上不能用。
:::

::: details FastAPI 里 def 和 async def 的路由有什么区别？
- `def`：FastAPI 会放进线程池（anyio，默认 40 个线程）执行，里面阻塞也不会卡住事件循环，但并发度受线程池大小限制。
- `async def`：直接在事件循环上跑，里面必须全是 `await` 非阻塞操作。

一旦在 `async def` 里调用了同步阻塞代码（`requests.get`、同步 DB 驱动、CPU 密集计算），整个 worker 上的所有请求都会排队。CPU 密集任务要用 `asyncio.to_thread` 或者进程池，更重的放到后台任务队列。
:::

::: details 为什么 Node.js 是「单线程」但能做文件 IO？
JS 代码跑在一个线程上，但 libuv 在背后维护了一个线程池（默认 4 个线程），用来做文件 IO、`dns.lookup`、部分 crypto 和 zlib。网络 IO 走 epoll/kqueue/IOCP，不占线程池。所以「单线程」指的是 JS 执行线程。线程池被慢磁盘占满时，`dns.lookup` 也会跟着变慢，这是个经典的排查坑。
:::

## 参考

- [epoll(7) man page](https://man7.org/linux/man-pages/man7/epoll.7.html)
- Dan Kegel, [The C10K problem](http://www.kegel.com/c10k.html)
- W. Richard Stevens, *UNIX Network Programming, Vol. 1*，第 6 章「I/O Models」
- Jens Axboe, [Efficient IO with io_uring](https://kernel.dk/io_uring.pdf)
- [psycopg 3: Asynchronous operations（Windows 事件循环说明）](https://www.psycopg.org/psycopg3/docs/advanced/async.html)
- [Python asyncio: Platform Support](https://docs.python.org/3/library/asyncio-platforms.html)
- [FastAPI: Concurrency and async / await](https://fastapi.tiangolo.com/async/)
- 实战代码：DocPilot `api/src/docpilot/cli.py`（`run_async`）、`api/src/docpilot/routes/documents.py`（`async def` 里同步解析 PDF）
