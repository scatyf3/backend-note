import type { Card } from '@lib/flashcards'

const R = '/backend/os-io-models'

export const cards: Card[] = [
  {
    id: 'io-sync-async-blocking',
    deck: 'backend',
    topic: 'IO 模型',
    q: 'IO 多路复用（epoll）算同步 IO 还是异步 IO？「阻塞 / 非阻塞」和「同步 / 异步」分别指什么？',
    a: '**同步 IO**。epoll 只告诉你 fd 就绪，数据从内核拷到用户空间这一步仍然要应用线程自己调 `read` 来完成。\n- **阻塞 / 非阻塞**：调用在数据没准备好时会不会卡住线程。\n- **同步 / 异步**：数据拷贝由谁完成。只有 IOCP、io_uring 这类「内核拷完再通知」的模型才算真正的异步 IO。',
    ref: `${R}#五种-io-模型`,
  },
  {
    id: 'io-epoll-vs-select',
    deck: 'backend',
    topic: 'epoll',
    q: '为什么 epoll 比 select 快？在什么场景下差距最大？',
    a: '1. **注册和等待分离**：`epoll_ctl` 注册一次，select 每次都要把整个 fd_set 拷进内核。\n2. **就绪链表**：内核在 fd 就绪时通过回调把它挂到链表上，`epoll_wait` 是 **O(就绪数)**，select/poll 是 **O(总数)**。\n3. 没有 `FD_SETSIZE` = 1024 的上限。\n**连接多、活跃少**的场景差距最大，比如 10 万个连接里只有 100 个活跃。',
    ref: `${R}#select-→-poll-→-epoll`,
  },
  {
    id: 'io-et-eagain',
    deck: 'backend',
    topic: 'epoll',
    q: 'epoll 边缘触发（ET）模式下，为什么必须循环读到 EAGAIN？',
    a: 'ET 只在缓冲区状态**变化**（从空变非空）时通知一次。如果这次只读了一部分，剩下的数据**不会再触发**通知（除非又来新数据），连接就挂住了。\n所以 ET 必须配**非阻塞 socket**，在循环里一直读到 `EAGAIN`。LT（默认）只要还有数据就会一直报告，不怕漏读，但唤醒次数更多。',
    ref: `${R}#lt-和-et`,
  },
  {
    id: 'io-reactor-proactor',
    deck: 'backend',
    topic: '事件循环',
    q: 'Reactor 和 Proactor 有什么区别？为什么 psycopg 3 的 async 模式在 Windows 默认事件循环上跑不起来？',
    a: '- **Reactor**（readiness）：通知「fd 可读」，应用自己去读。epoll、kqueue、asyncio 的 `SelectorEventLoop`。\n- **Proactor**（completion）：应用提交「读到 buffer」的请求，内核读完再通知。IOCP、io_uring、asyncio 的 `ProactorEventLoop`。\nPython 3.8 起，Windows 默认用 `ProactorEventLoop`（IOCP），它**不实现 `add_reader()`**。而 psycopg 3 async 要等 libpq socket 可读，是 Reactor 用法，所以要显式换成 `SelectorEventLoop`。DocPilot 的 `cli.py` 就是这么做的：`asyncio.run(coro, loop_factory=asyncio.SelectorEventLoop)`。',
    ref: `${R}#实战-docpilot-在-windows-上为什么要换事件循环`,
  },
  {
    id: 'io-blocking-in-async',
    deck: 'backend',
    topic: '事件循环',
    q: 'FastAPI 里 `def` 路由和 `async def` 路由有什么区别？在 `async def` 里解析一个 20 MB 的 PDF 会怎样？',
    a: '- `def`：FastAPI 放进**线程池**（anyio，默认 40 个线程）执行，阻塞也不会卡住事件循环。\n- `async def`：直接在**事件循环**上执行，你必须保证里面不阻塞。\n在 `async def` 里同步解析 PDF，解析期间同一个 worker 上**所有请求都会卡住**，正在流式输出的聊天也会停止吐字。DocPilot 的上传接口就是这种情况。修法：`await asyncio.to_thread(parse_document, ...)`，或者把 ingest 改成后台任务、接口直接返回 202。',
    ref: `${R}#事件循环最大的坑-在-async-函数里做阻塞操作`,
  },
  {
    id: 'io-redis-single-thread',
    deck: 'backend',
    topic: 'Redis',
    q: 'Redis 是单线程的，为什么还能这么快？6.0 加的 IO threads 改了什么、没改什么？',
    a: '快的原因：1. 纯内存操作，命令通常在微秒级完成；2. epoll 事件循环，一个线程就能管上万个连接；3. 单线程不用加锁，也没有上下文切换。\n6.0 的 **IO threads** 只把**读写 socket 和协议解析**并行化，**命令执行仍然是单线程**，原子性保证不变。\n代价：一个慢命令（`KEYS *`、删除大 key）会阻塞所有客户端。',
    ref: `${R}#追问`,
  },
  {
    id: 'io-file-epoll',
    deck: 'backend',
    topic: '文件 IO',
    q: '普通文件能用 epoll 做异步 IO 吗？Node.js / asyncio 是怎么做文件 IO 的？',
    a: '**不能**。对普通文件调 `epoll_ctl` 会返回 `EPERM`，select/poll 则永远报告「就绪」，因为磁盘读取在概念上总能进行，只是慢。\n所以 libuv 用**线程池**做文件 IO（`UV_THREADPOOL_SIZE` 默认 4），`aiofiles` 底下也是线程。真正对文件也异步的是 **io_uring**（Linux 5.1+）：共享 SQ/CQ 两个环形队列，批量提交、批量收割。',
    ref: `${R}#文件-io-和零拷贝`,
  },
]
