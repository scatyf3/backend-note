---
title: OS 与 IO 模型
---

# OS 与 IO 模型

这一格解决的是「怎么用少量线程同时服务上万个连接」。一连接一线程的模型被线程内存和上下文切换拖垮（C10K），所以改成非阻塞 socket + IO 多路复用：epoll / kqueue 告诉你哪些 fd 就绪（readiness，Reactor），IOCP / io_uring 则替你把 IO 做完再通知（completion，Proactor）。代价是编程模型变成事件驱动，并且**任何一个阻塞调用都会卡住整个事件循环**。

- **epoll 比 select 快**：注册一次、就绪链表、O(就绪数)；ET 模式必须读到 `EAGAIN`。
- **readiness 和 completion 不能混用**：psycopg 3 async 依赖 `add_reader`，在 Windows 默认的 `ProactorEventLoop` 上跑不起来（DocPilot 实际踩到）。
- **`async def` 里调用同步阻塞代码比直接写 `def` 更糟**：CPU 密集任务要放到线程池或后台任务里。

笔记：[OS 与 IO 模型](/backend/os-io-models)

**延伸阅读**：[epoll(7)](https://man7.org/linux/man-pages/man7/epoll.7.html)、[The C10K problem](http://www.kegel.com/c10k.html)
