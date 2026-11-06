---
title: 容器、K8s 与 CI/CD：把代码可靠地送上线
status: draft
tags: [docker, kubernetes, ci-cd, deployment, migrations, health-check]
difficulty: 3
order: 19
related: [/backend/observability, /backend/progressive-delivery, /backend/idempotency, /backend/streaming-sse-websocket, /backend/background-jobs]
stack: [ops-deploy]
---

# {{ $frontmatter.title }}

## 一句话结论

上线的目标是：==同一份制品（镜像）经过自动化测试，以可重复、可回滚、不中断服务的方式替换掉旧版本==。容器解决「在我机器上能跑」，把代码和依赖打包成不可变的镜像；Kubernetes（或 Fly、Cloud Run 这类平台）负责调度、扩缩容、健康检查和滚动更新；CI/CD 把「测试 → 构建 → 迁移 → 部署」变成每次提交自动跑的流水线。最容易出事的不是这些工具本身，而是几个边界：**数据库迁移必须和新旧两个版本的代码都兼容**、**健康检查要分清存活和就绪**、**优雅关闭要等正在进行的请求（尤其是长时间的流式响应）结束**。

## 容器：把运行环境变成制品

### 镜像怎么写

两个仓库的 Dockerfile 都很短，可以当作基线：

```dockerfile
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .
CMD ["uvicorn", "docpilot.app:app", "--host", "0.0.0.0", "--port", "8000"]
```

做对的地方：

- **slim 基础镜像**，`--no-cache-dir` 不把 pip 缓存打进镜像，镜像更小。
- `PYTHONUNBUFFERED=1`：stdout 不缓冲，日志能实时被平台收集。
- **CMD 用 exec 形式**（JSON 数组）：uvicorn 直接作为 PID 1 运行，能收到平台发来的 SIGTERM，从而优雅关闭。如果写成 shell 形式（`CMD uvicorn ...`），PID 1 是 `/bin/sh`，信号不一定会转发给 uvicorn。

可以改进的地方：

- **层缓存的顺序**：`pip install .` 同时安装依赖和项目自身，源码一改，依赖层就失效，每次都要重新装依赖。更好的做法是先只复制依赖声明、安装依赖，再复制源码。
- **非 root 用户**：两个镜像都以 root 运行，应该加一个普通用户（`USER app`），万一被入侵，影响范围更小。
- **固定基础镜像**：`python:3.12-slim` 会随着上游更新而变化，生产环境可以固定到具体的 digest，保证构建可复现。
- **多阶段构建**：编译依赖（gcc 等）只放在构建阶段，运行镜像只保留产物。

### 一个容器一个进程

LLMGateway 的 Dockerfile 里有一段注释：**每个容器只跑一个 uvicorn worker，这是故意的**。所有共享状态（限流、预算、缓存）都在 Redis 里，扩容就是加容器副本；而进程内的状态（Prometheus 的指标注册表、mock 后端的开关）只有一份，不会产生歧义。如果一个容器里跑 4 个 worker，Prometheus 抓取 `/metrics` 时每次只会命中其中一个 worker，看到的数字就是错的。==扩容交给编排平台加副本，而不是在容器里开多个进程==，这样监控、健康检查、资源限制都是一一对应的。

### 配置和密钥

遵循 12-factor：同一个镜像用于所有环境，差异只来自环境变量。DocPilot 的 `fly.toml` 里只放不敏感的配置（`LLM_PROVIDER`、`RETRIEVAL_MODE`、`CORS_ORIGINS`），数据库地址和 API key 用 `fly secrets set` 注入。LLMGateway 把默认的 `gateway.yaml` 打进镜像，同时允许用环境变量覆盖路径和其中的值。密钥永远不进镜像、不进代码仓库。

## Kubernetes 的核心概念

| 概念 | 作用 |
|---|---|
| Pod | 调度的最小单位，一个或几个共享网络的容器 |
| Deployment | 声明「要跑 N 个这样的 Pod」，负责滚动更新和回滚 |
| Service | 给一组 Pod 一个稳定的虚拟 IP / DNS 名，做负载均衡 |
| Ingress / Gateway | 把外部的 HTTP 流量路由到 Service |
| ConfigMap / Secret | 配置和密钥，以环境变量或文件的形式注入 |
| HPA | 根据 CPU、内存或自定义指标自动调整副本数 |

### 资源请求和限制

- `requests` 是调度依据（保证能分到的资源），`limits` 是上限。
- CPU 超过 limit 会被**限流**（变慢，而且是在不知不觉中）；内存超过 limit 会被**杀掉**（OOMKilled）。
- 内存的 limit 要按峰值设，并且留出余量。DocPilot 在 Fly 上只有 512 MB，一次解析一个 20 MB 的 PDF 加上 embedding 批处理，就可能接近上限。

### 健康检查：存活和就绪要分开

| 探针 | 回答的问题 | 失败的后果 |
|---|---|---|
| **liveness** | 进程还活着吗？卡死了吗？ | **重启**容器 |
| **readiness** | 现在能接流量吗？ | 从负载均衡里**摘除**，不重启 |
| startup | 启动完成了吗？ | 启动期间不做 liveness 检查 |

DocPilot 的 `/healthz` 会执行一次 `SELECT 1`，检查数据库能不能连通。这是一个**就绪检查**：数据库不通时，摘掉这个实例的流量是对的。但如果把它当成存活检查，**数据库一抖动，所有实例都会被重启**，重启又解决不了数据库的问题，反而让恢复更慢。==存活检查只检查进程自身，不检查依赖==。Fly 的 `http_service.checks` 用于路由判断，语义上更接近就绪检查。

### 优雅关闭：对流式服务尤其重要

滚动更新时，旧的 Pod 会收到 SIGTERM。正确的流程是：

1. 从负载均衡里摘除，不再接收新请求（readiness 变为失败，或者靠 preStop hook 等几秒钟让摘除生效）；
2. **等正在处理的请求完成**；
3. 超过宽限期（`terminationGracePeriodSeconds`，默认 30 秒）还没结束，就会被强制杀掉（SIGKILL）。

普通 API 几百毫秒就能结束，但 **LLM 的流式响应可能持续一两分钟**。每次发布，正在生成的回答都会被中途截断。对策：

- 宽限期设得比最长的流还长，并配置服务器的优雅关闭超时（uvicorn 的 `--timeout-graceful-shutdown`）；
- 客户端支持断线续传，生成过程和连接解耦（见[流式接口](/backend/streaming-sse-websocket)）；
- 长任务放到后台 worker 里，worker 关闭时释放租约，让别的实例接手（见[后台任务](/backend/background-jobs)）。

### 缩容到零

DocPilot 的 Fly 配置是 `min_machines_running = 0`、`auto_stop_machines = "stop"`：没有流量时机器停掉，不花钱；有请求时自动启动。代价是**冷启动**：第一个请求要等机器启动、Python 加载、建立数据库连接池，可能要好几秒。对演示项目来说这是正确的取舍，对用户量大的服务则要保留至少一个实例。

## CI/CD

### CI：每次提交都要跑的检查

DocPilot 的 `ci.yml` 有两个任务：

- **api**：启动一个 `pgvector/pgvector:pg16` 服务容器，跑 ruff 检查、校验 eval 数据集（`python -m evals.dataset` 确保每条标注的原文片段确实存在于语料里），然后运行 pytest。测试用的是假的 LLM 和假的 embedder，**不需要任何 API key**，而带数据库的集成测试照样能跑。
- **web**：lint 加上 Next.js 的构建。

另外，eval 是一个**单独的 workflow**，只在 PR 改动了 prompt、切分、检索相关的代码时才运行（见[离线 eval](/stack/ev-offline)）：这类检查又慢又花钱，不必每次提交都跑。

### CD：构建一次，到处部署

- **同一个镜像**从测试环境一路提升到生产，不要每个环境重新构建（重新构建可能装到不同版本的依赖）。
- 每个镜像打上 git commit 的标签，出了问题能精确地知道线上跑的是哪个版本，回滚就是重新部署上一个标签。

### 数据库迁移：最容易出事的一步

DocPilot 用 Fly 的 `release_command = "docpilot db init"`：每次部署时，先在一台临时机器上执行它，成功了才开始替换应用实例，失败则终止部署。`schema.sql` 全是 `CREATE ... IF NOT EXISTS`，所以重复执行是幂等的。

但它只能处理**新增**（新建表、新建索引）。一旦要改列名、删列、改类型，就需要真正的迁移工具（Alembic、Flyway），并且遵守 **expand / contract（先扩后缩）**：

1. **expand**：先加新列（可为空），部署能同时读写新旧两列的代码；
2. **迁移数据**：后台把旧数据回填到新列；
3. **切换**：部署只使用新列的代码；
4. **contract**：确认没有旧代码在跑了，再删除旧列。

原因是滚动更新期间，**新旧两个版本的代码会同时运行**，而且随时可能需要回滚。任何时刻的数据库结构都必须同时兼容新旧两个版本。==直接在一次部署里改列名，就是在制造一次必然发生的故障==。

## 追问

::: details 写 Dockerfile 有哪些最佳实践？
1. 用 slim 或 distroless 基础镜像，生产环境固定 digest；
2. 层的顺序按变化频率从低到高排：先复制依赖声明并安装依赖，再复制源码，充分利用层缓存；
3. 多阶段构建，编译工具不进入运行镜像；
4. 以非 root 用户运行；
5. CMD 用 exec 形式，让应用成为 PID 1，能直接收到 SIGTERM；
6. 用 `.dockerignore` 排除无关文件，密钥不进镜像。
:::

::: details 为什么 LLMGateway 每个容器只跑一个 worker 进程？
所有共享状态在 Redis 里，扩容只需要加容器副本。一个容器跑多个 worker 时，进程内的状态（比如 Prometheus 的指标注册表）有多份，抓取 `/metrics` 只能命中其中一个，数字是错的；健康检查和资源限制也没法一一对应到进程。原则是扩容交给编排平台加副本，一个容器一个进程。
:::

::: details liveness 和 readiness 探针有什么区别？为什么存活检查不应该检查数据库？
liveness 失败会重启容器，回答「进程是否卡死」；readiness 失败只会把实例从负载均衡里摘掉，回答「现在能不能接流量」。如果 liveness 检查数据库，数据库一抖动，所有实例都会被重启，重启解决不了数据库的问题，还会让恢复更慢。DocPilot 的 `/healthz` 执行 `SELECT 1`，适合作为 readiness 检查。
:::

::: details 滚动发布时，正在进行的 LLM 流式响应会怎样？怎么处理？
旧实例收到 SIGTERM 后，如果宽限期（K8s 默认 30 秒）内流还没结束，就会被强制杀掉，用户看到回答被截断。处理办法：先从负载均衡摘除、停止接收新请求；把宽限期和服务器的优雅关闭超时设得比最长的流还长；客户端支持断线续传，让生成和连接解耦；长任务放进后台 worker，关闭时释放租约交给别的实例。
:::

::: details 数据库迁移怎么做才能不停机？什么是 expand / contract？
滚动更新期间新旧代码同时运行，还可能回滚，所以任何时刻的 schema 都要同时兼容两个版本。expand / contract：先加新列，部署同时兼容新旧两列的代码；后台回填数据；部署只用新列的代码；确认旧代码都下线后再删旧列。改列名、删列都不能在一次部署里直接完成。DocPilot 的 `CREATE IF NOT EXISTS` 只适合新增，破坏性的变更需要迁移工具。
:::

::: details 为什么要「构建一次，到处部署」？
每个环境重新构建，可能装到不同版本的依赖或基础镜像，测试环境验证过的东西不等于生产环境跑的东西。用同一个镜像（用 commit 打标签）从测试一路提升到生产，线上版本可以精确追溯，回滚就是重新部署上一个标签。
:::

::: details 缩容到零有什么好处和代价？
好处：没有流量时不花钱，适合演示项目和低频服务。代价是冷启动：第一个请求要等机器启动、运行时加载、连接池建立，可能要好几秒。DocPilot 在 Fly 上设置 `min_machines_running = 0`，对演示项目是合理的取舍；用户量大或对延迟敏感的服务至少保留一个常驻实例。
:::

## 参考

- [Docker: Best practices for writing Dockerfiles](https://docs.docker.com/build/building/best-practices/)
- [Kubernetes: Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)、[Pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)
- [The Twelve-Factor App](https://12factor.net/)
- [Fly.io: release_command](https://fly.io/docs/reference/configuration/#run-one-off-commands-before-releasing-a-deployment)
- Martin Fowler, [Parallel Change（expand / contract）](https://martinfowler.com/bliki/ParallelChange.html)
- 实战代码：DocPilot `api/Dockerfile`、`api/fly.toml`、`docker-compose.yml`、`.github/workflows/ci.yml`；LLMGateway `Dockerfile`
