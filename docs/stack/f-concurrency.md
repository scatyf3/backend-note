---
title: 并发模型
---

# 并发模型

这一格解决的是「怎么同时推进很多件事，又不把共享数据弄乱」。核心取舍是一个等待中的任务占多少资源、谁来决定切换：OS 线程抢占式但贵；事件循环 + 协程协作式、便宜，但一个阻塞会卡住全部；goroutine 和 Java virtual thread 用 M:N 调度，两头兼顾，代价是运行时更复杂。共享可变状态要靠锁、原子操作或消息传递来保护，协程里跨 `await` 的「检查再执行」同样会出竞态。

- **IO 密集看「等待便不便宜」，CPU 密集看「能不能用多核」**：Python 有 GIL，CPU 密集要用多进程。
- **一个 DB 连接同一时刻只能跑一条查询**：并发查询要从连接池各借一个连接，连接池同时也是背压机制。
- **`gather` 一个任务失败不会取消其他任务，`TaskGroup` 会**；客户端断开时抛的 `CancelledError` / `GeneratorExit` 是 `BaseException`，`except Exception` 接不住。

笔记：[并发模型：线程、事件循环与协程](/backend/concurrency-models)

**延伸阅读**：[What Color is Your Function?](https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/)、[JEP 444: Virtual Threads](https://openjdk.org/jeps/444)
