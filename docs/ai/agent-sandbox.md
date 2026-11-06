---
title: Agent 权限与沙箱：把最坏情况限制住
status: draft
tags: [agent, security, least-privilege, sandbox, authorization]
difficulty: 4
order: 19
related: [/ai/prompt-injection, /backend/auth, /ai/long-running-agents, /ai/tool-calling-mcp, /ai/guardrails, /backend/owasp, /ai/llm-gateway]
stack: [sec-sandbox]
---

# {{ $frontmatter.title }}

## 一句话结论

既然要假设模型**一定会**被注入或者犯错，那么 ==agent 能造成的最大损害，就等于它拥有的权限==。所以安全设计的重点不是让模型「更听话」，而是把最坏情况限制住：

- **工具最小化、按风险分级**；
- **以用户的身份执行**（委托授权、短期、限定范围的 token），而不是用一个超级账号；
- **代码和命令在沙箱里执行**：隔离、默认禁止出站网络、只读文件系统、资源和时间上限；
- **高风险操作要人工审批**；
- **全程审计，操作尽量可逆**；
- **用预算限制失控**。

## 为什么权限决定了上限

OWASP 的 LLM Top 10 里有一条叫 **excessive agency（过度授权）**，分成三个方面：

- **功能过多**：一个只需要读邮件的 agent，拿到的工具却能发邮件、删邮件；
- **权限过大**：工具背后的凭证能访问所有用户的数据，而不只是当前用户的；
- **自主性过高**：有副作用的操作不经确认就直接执行。

prompt injection 能不能造成严重后果，几乎完全取决于这三点（见 [Prompt injection](/ai/prompt-injection)）。一个只能搜索当前用户文档的 agent，被注入了最多也就是回答错误；一个能以管理员身份执行任意 SQL 的 agent，被注入一次就可能删掉整个数据库。

## 工具层：最小功能

### 用窄的、面向任务的工具

- 给 `search_docs(query, top_k)`，而不是 `run_sql(sql)`；
- 读和写分成不同的工具，写操作的工具单独授权；
- 参数严格校验：DocPilot 用 pydantic 的 `extra="forbid"` 拒绝多余的字段，`top_k` 限制在 1 到 10 之间，`create_page` 的标题最长 200 个字符（见 [Tool calling 与 MCP](/ai/tool-calling-mcp)）；
- **按场景只挂载需要的工具**：一个只做问答的接口，不需要挂上写入的工具。

### 按风险分级

| 级别 | 例子 | 策略 |
|---|---|---|
| 只读、范围受限 | 搜索当前用户的文档 | 自动执行 |
| 可逆的写操作 | 新建一篇草稿 | 自动执行，或者事后确认，并且支持撤销 |
| 不可逆或对外的操作 | 删除、发送邮件、付款、执行代码 | 事前人工审批，最好在沙箱里执行 |

审批的实现见[长任务与 human-in-the-loop](/ai/long-running-agents)。

## 身份层：以用户的身份执行

agent 调用工具时，应该**代表当前用户**，权限不超过用户本人，而不是用服务自己的高权限账号：

- 把用户的身份和权限一路传到工具执行层，工具内部按用户的权限做检查，比如检索时带上 `tenant_id` 的过滤（见[认证与鉴权](/backend/auth)）；
- 调用外部系统时，用**委托授权**换取一个**范围更小、有效期更短**的 token（OAuth 的 token exchange），而不是把用户的完整凭证交给 agent；
- 否则就会出现 **confused deputy**：用户本身没有权限，却能借 agent 之手完成。

DocPilot 目前是单用户的，`create_page` 写入的文档统一标记为 `source='agent'`、`kind='generated'`。这个来源标记本身是一种好的做法：AI 生成的内容和用户上传的内容可以区分，后续可以单独审查、降低检索权重或者批量清理。多用户化之后，还要记录是**哪个用户的哪一轮对话**触发了这次写入。

## 执行层：沙箱

agent 需要执行代码或命令时（数据分析、编码 agent），必须在隔离的环境里执行。

### 隔离的强度

| 方式 | 隔离强度 | 说明 |
|---|---|---|
| 同一进程里 `exec` | 没有隔离 | 绝对不要这样做 |
| 子进程 + 受限用户 | 弱 | 共享文件系统和网络 |
| 容器 | 中 | 共享宿主机内核，内核漏洞可能导致逃逸 |
| gVisor | 较强 | 在用户态实现一个内核，拦截系统调用 |
| Firecracker 等 microVM | 强 | 独立的轻量虚拟机，启动只要很短时间 |
| WebAssembly | 强 | 能力模型，默认什么都不能访问 |

### 沙箱里要限制什么

- **网络**：==默认禁止出站==，需要的话只允许访问白名单里的域名。这一条直接切断了「致命三要素」里的对外通信，也防止 SSRF。
- **文件系统**：临时的、用完即销毁；只挂载必要的目录，尽量只读。
- **密钥**：不放进沙箱的环境变量。需要调用外部服务时，由沙箱外的代理代为签名或注入凭证。
- **资源**：CPU、内存、磁盘、进程数的上限，以及执行时间的上限。
- **输出**：限制输出的大小，输出的内容同样当作不可信的数据处理。

## 审计与可逆

- **记录每一次工具调用**：工具名、参数、结果摘要、耗时、是否出错、谁触发的。DocPilot 的 trace 里有每一轮的工具日志（见 [LLM tracing](/stack/ev-tracing)）。
- **让操作可逆**：删除改成软删除，写入先存为草稿，对外发送之前先进入一个可以撤回的队列。
- **dry-run**：对于批量操作，先让 agent 输出「将要执行什么」，确认之后再执行。

## 预算也是安全边界

失控的 agent（陷入循环、被诱导反复调用工具）首先表现为成本和资源的失控：

- **步数上限**：DocPilot 每轮最多 6 步（见 [Agent 循环](/ai/agent-loop)）；
- **按 key 的限流和预算**：LLMGateway 给每个 API key 设置了每分钟请求数、每分钟 token 数和每月预算，一个失控的 agent 最多只能花掉它那个 key 的额度（见 [LLM 网关](/ai/llm-gateway)）；
- **按等级限制模型**：免费等级的 key 只能使用便宜的模型，请求贵的模型会被降级；
- **工具级别的限流**：比如每个会话每小时最多创建 N 个页面。

## 追问

::: details 为什么说 agent 能造成的最大损害等于它的权限？
因为 prompt injection 和模型犯错都无法完全避免，模型的行为无法保证。一旦被注入，攻击者能做的事情就是 agent 被授予的所有能力。所以安全设计的重点是限制权限：工具最小化、按用户授权、沙箱执行、高风险操作审批，让最坏情况也在可接受的范围内。
:::

::: details 什么是 excessive agency（过度授权）？包含哪几个方面？
OWASP LLM Top 10 中的一类风险，分三个方面：功能过多（给了不需要的工具，比如只需读邮件却能发邮件）；权限过大（工具背后的凭证能访问所有用户的数据）；自主性过高（有副作用的操作不经确认直接执行）。对策分别是工具最小化、以用户身份执行、按风险分级审批。
:::

::: details agent 调用外部系统时，应该用什么身份？
以当前用户的身份，权限不超过用户本人。具体做法是用委托授权（比如 OAuth token exchange）换取一个范围更小、有效期更短的 token，而不是用服务的高权限账号，也不把用户的完整凭证交给 agent。否则就是 confused deputy：用户借 agent 之手做到了自己没有权限做的事。
:::

::: details 让 agent 执行代码，沙箱要怎么设计？
1. 隔离强度：至少用容器，最好用 gVisor 或 microVM，绝不在同一进程里 exec；
2. 网络默认禁止出站，需要的话用白名单；
3. 文件系统是临时的，只挂载必要目录，尽量只读；
4. 密钥不进沙箱，由外部代理注入；
5. 限制 CPU、内存、进程数和执行时间；
6. 限制输出大小，输出当作不可信数据。
:::

::: details 为什么沙箱要默认禁止出站网络？
它同时解决两个问题：一是切断数据外泄的通道（「致命三要素」里的对外通信），被注入的代码读到了数据也发不出去；二是防止 SSRF，沙箱里的代码不能访问内网服务和云厂商的元数据地址。确实需要访问外部资源时，用域名白名单，并在解析 DNS 之后检查 IP。
:::

::: details 除了审批，还有哪些办法降低 agent 写操作的风险？
让操作可逆：软删除而不是硬删除，写入先存为草稿，对外发送前进入可撤回的队列；批量操作先 dry-run，输出将要执行的动作，确认后再执行；给生成的内容打上来源标记（DocPilot 的 `kind='generated'`），便于审查和清理；对工具做速率限制；完整记录每次工具调用。
:::

::: details 怎么防止一个失控的 agent 把钱花光？
多层预算：每轮的步数上限（DocPilot 是 6 步）；网关层按 API key 的 RPM、TPM 限流和每月预算（LLMGateway），一个 agent 最多花掉自己 key 的额度；按等级限制能用的模型；工具级别的速率限制；以及对异常的消耗速度告警。
:::

## 参考

- [OWASP Top 10 for LLM Applications: Excessive Agency](https://genai.owasp.org/llm-top-10/)
- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [gVisor](https://gvisor.dev/docs/)、[Firecracker](https://firecracker-microvm.github.io/)
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)（工具设计与 guardrails）
- 实战代码：DocPilot `agent/tools.py`（参数校验、`create_page`）、`agent/loop.py`（`max_steps`）、`schema.sql`（`documents.kind`、`source`）；LLMGateway `gateway/limits.py`、`config/gateway.yaml`（tiers、rpm、tpm、budget）
