import type { Card } from '@lib/flashcards'

const R = '/backend/containers-cicd'

export const cards: Card[] = [
  {
    id: 'deploy-dockerfile',
    deck: 'backend',
    topic: '容器',
    q: '写 Dockerfile 有哪些最佳实践？DocPilot 的 Dockerfile 哪些做对了、哪些可以改进？',
    a: '**做对的**：slim 基础镜像；`--no-cache-dir`；`PYTHONUNBUFFERED=1` 让日志实时输出；**CMD 用 exec 形式**，uvicorn 是 PID 1，能直接收到 SIGTERM。\n**可以改进**：\n1. **层缓存顺序**：`pip install .` 同时装依赖和项目，源码一改依赖层就失效，应该先只装依赖再复制源码；\n2. 以**非 root** 用户运行；\n3. 生产环境**固定基础镜像 digest**；\n4. 多阶段构建，编译工具不进运行镜像。',
    ref: `${R}#镜像怎么写`,
  },
  {
    id: 'deploy-one-process',
    deck: 'backend',
    topic: '容器',
    q: '为什么 LLMGateway 每个容器只跑一个 uvicorn worker？',
    a: '所有共享状态（限流、预算、缓存）都在 **Redis** 里，扩容只要**加容器副本**。\n如果一个容器跑多个 worker：进程内的状态（**Prometheus 指标注册表**、mock 后端的开关）会有多份，抓取 `/metrics` 每次只能命中其中一个 worker，**数字是错的**；健康检查和资源限制也没法一一对应到进程。\n原则：扩容交给编排平台加副本，一个容器一个进程。',
    ref: `${R}#一个容器一个进程`,
  },
  {
    id: 'deploy-probes',
    deck: 'backend',
    topic: 'K8s',
    q: 'liveness 和 readiness 探针有什么区别？为什么存活检查不应该检查数据库？',
    a: '- **liveness**：进程是否卡死？失败就**重启**容器。\n- **readiness**：现在能不能接流量？失败就从负载均衡**摘除**，不重启。\n如果 liveness 检查数据库，**数据库一抖动，所有实例都会被重启**，重启解决不了数据库的问题，还让恢复更慢。\nDocPilot 的 `/healthz` 会 `SELECT 1`，适合当 **readiness** 用。原则：存活检查只检查进程自身。',
    ref: `${R}#健康检查-存活和就绪要分开`,
  },
  {
    id: 'deploy-graceful-stream',
    deck: 'backend',
    topic: 'K8s',
    q: '滚动发布时，正在进行的 LLM 流式响应会怎样？怎么处理？',
    a: '旧 Pod 收到 SIGTERM，如果宽限期（`terminationGracePeriodSeconds`，默认 **30 秒**）内流没结束，就会被 **SIGKILL**，用户看到回答被截断。而 LLM 流可能持续一两分钟。\n处理：\n1. 先从负载均衡**摘除**，停止接收新请求；\n2. 宽限期和服务器的优雅关闭超时（uvicorn `--timeout-graceful-shutdown`）设得**比最长的流还长**；\n3. 客户端支持**断线续传**，生成和连接解耦；\n4. 长任务放进后台 worker，关闭时释放租约。',
    ref: `${R}#优雅关闭-对流式服务尤其重要`,
  },
  {
    id: 'deploy-resources',
    deck: 'backend',
    topic: 'K8s',
    q: 'K8s 里 CPU 和内存超过 limit 分别会发生什么？',
    a: '- `requests` 是**调度依据**（保证能分到的资源），`limits` 是**上限**。\n- **CPU 超过 limit**：被**限流**（throttling），进程变慢，而且是悄悄变慢，很难察觉。\n- **内存超过 limit**：进程被**杀掉**（OOMKilled），然后重启。\n内存 limit 要按峰值设并留余量。比如 DocPilot 在 Fly 上只有 512 MB，解析一个 20 MB 的 PDF 再做 embedding 批处理，就可能接近上限。',
    ref: `${R}#资源请求和限制`,
  },
  {
    id: 'deploy-expand-contract',
    deck: 'backend',
    topic: '迁移',
    q: '为什么数据库迁移不能在一次部署里直接改列名？什么是 expand / contract？',
    a: '滚动更新期间**新旧两个版本的代码同时运行**，还可能随时回滚，所以任何时刻的 schema 都必须**同时兼容新旧代码**。直接改列名，旧代码立刻报错。\n**expand / contract**：\n1. **expand**：加新列，部署同时读写新旧两列的代码；\n2. 后台**回填**数据；\n3. 部署只用新列的代码；\n4. **contract**：确认旧代码都下线后，再删旧列。\nDocPilot 的 `CREATE ... IF NOT EXISTS` 幂等，但只适合新增，破坏性变更需要迁移工具。',
    ref: `${R}#数据库迁移-最容易出事的一步`,
  },
  {
    id: 'deploy-release-command',
    deck: 'backend',
    topic: 'CD',
    q: 'DocPilot 的 Fly 配置里 `release_command = "docpilot db init"` 起什么作用？为什么要求它幂等？',
    a: '每次部署时，先在一台**临时机器**上执行这条命令（初始化或迁移 schema），**成功了才开始替换应用实例，失败就终止部署**，避免新代码跑在旧 schema 上。\n**幂等**：部署可能重试、可能多次触发，所以命令必须能重复执行。`schema.sql` 全是 `CREATE ... IF NOT EXISTS`，扩展用 `CREATE EXTENSION IF NOT EXISTS`；`reset` 时还会拒绝删除 `public` schema。',
    ref: `${R}#数据库迁移-最容易出事的一步`,
  },
  {
    id: 'deploy-ci-design',
    deck: 'backend',
    topic: 'CI',
    q: 'DocPilot 的 CI 怎么做到不需要任何 API key，也能跑带数据库的集成测试？为什么 eval 要单独成一个 workflow？',
    a: '**不需要 key**：CI 启动一个 `pgvector/pgvector:pg16` **服务容器**作为真实数据库，LLM 和 embedding 用**假的实现**（脚本化的 provider、哈希词袋 embedder），所以集成测试照样能跑，结果完全确定。还会校验 eval 数据集（每条标注的原文片段确实存在于语料里）。\n**eval 单独跑**：它又慢又花钱（真实模型 + judge），只在 PR 改动了 prompt、切分、检索等相关路径时才触发，并把与 baseline 的差异贴到 PR 评论里。',
    ref: `${R}#ci-每次提交都要跑的检查`,
  },
]
