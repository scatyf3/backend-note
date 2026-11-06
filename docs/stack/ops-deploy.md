---
title: 容器、K8s 与 CI/CD
---

# 容器、K8s 与 CI/CD

上线的目标是让同一个经过测试的镜像，以可重复、可回滚、不中断服务的方式替换旧版本。容器把运行环境变成不可变的制品；编排平台负责调度、扩缩容、健康检查和滚动更新；CI/CD 让测试、构建、迁移、部署在每次提交时自动运行。最容易出事的是三个边界：迁移必须同时兼容新旧两个版本的代码（expand / contract），存活检查和就绪检查要分开，优雅关闭要等正在进行的请求结束。

- **一个容器一个进程**：LLMGateway 每个容器只跑一个 worker，状态在 Redis，扩容就是加副本，指标也不会对不上。
- **存活检查不要检查依赖**：DocPilot 的 `/healthz` 会 `SELECT 1`，适合当就绪检查；当存活检查的话，数据库一抖所有实例都会被重启。
- **流式响应和滚动发布冲突**：宽限期要比最长的流还长，或者支持断线续传。

笔记：[容器、K8s 与 CI/CD](/backend/containers-cicd)

**延伸阅读**：[Kubernetes: Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)、[Parallel Change](https://martinfowler.com/bliki/ParallelChange.html)
