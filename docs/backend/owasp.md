---
title: 应用安全：OWASP Top 10 与 AI 时代的新入口
status: draft
tags: [security, owasp, injection, access-control, supply-chain, ssrf]
difficulty: 3
order: 22
related: [/backend/auth, /backend/privacy-pii, /ai/prompt-injection, /ai/agent-sandbox, /backend/containers-cicd, /backend/api-design]
stack: [sec-owasp]
---

# {{ $frontmatter.title }}

## 一句话结论

OWASP Top 10 是 Web 应用最常见的十类风险，2025 版的前三名是**访问控制失效**、**安全配置错误**和**软件供应链失败**。几乎所有条目都能归结为一个原则：==不信任任何来自边界之外的输入，并且默认只给最小的权限==。具体做法是参数化查询、在每个对象上做鉴权、安全的默认配置、锁定依赖版本、不把内部错误暴露出去。AI 时代没有让这些问题消失，反而多了新的入口：上传的文档、检索到的内容、模型的输出、agent 调用的工具，**都是不可信的输入**。

## 为什么安全问题总是那几类

绝大多数漏洞都来自同一个错误：**把数据当成了代码，或者把不可信的东西当成了可信的**。

- 拼接进 SQL 的用户输入被当成了 SQL（注入）；
- URL 里的 id 被当成了「这个人有权访问」的证明（越权）；
- 用户提供的 URL 被服务器原样请求（SSRF）；
- 文档里的一句话被模型当成了指令（prompt injection）。

所以防御也有共同的思路：**在边界上区分数据和指令，对每一次访问检查权限，失败时安全地失败**。

## OWASP Top 10:2025

| 编号 | 类别 | 一句话 | 典型防御 |
|---|---|---|---|
| A01 | 访问控制失效 | 能访问或修改不属于自己的数据（IDOR），**SSRF 也并入了这一类** | 每个对象都在服务端检查归属；默认拒绝 |
| A02 | 安全配置错误 | 默认密码、调试模式、过宽的 CORS、多余的端口 | 安全的默认值，配置即代码，定期审查 |
| A03 | **软件供应链失败** | 被投毒的依赖、被篡改的构建流程 | 锁文件 + 哈希校验，最小化依赖，固定 CI 动作的版本 |
| A04 | 加密失败 | 明文传输或存储敏感数据，弱算法 | 全程 TLS，静态加密，用成熟的库 |
| A05 | 注入 | SQL、命令、模板注入 | 参数化查询，标识符用白名单 |
| A06 | 不安全的设计 | 架构层面缺少安全考虑（比如没有限流） | 威胁建模，安全需求前置 |
| A07 | 身份认证失败 | 弱密码、会话固定、凭证填充 | MFA、限流、安全的会话管理 |
| A08 | 软件或数据完整性失败 | 不安全的反序列化、未签名的更新 | 签名校验，不反序列化不可信数据 |
| A09 | 安全日志与告警失败 | 被攻击了却不知道 | 记录安全事件，并且告警 |
| A10 | **异常情况处理不当** | 出错时泄露信息、绕过检查、资源耗尽 | 失败时默认拒绝，错误信息脱敏，设置资源上限 |

和 2021 版相比，变化主要有三点：SSRF 并入了 A01；「易受攻击和过时的组件」扩大成了 A03 软件供应链失败；新增了 A10 异常情况处理不当。

## 实战：用 OWASP 的视角看两个仓库

### 做对的地方

**注入（A05）**：DocPilot 所有的数据查询都用 psycopg 的参数占位符（`%s` / `%(name)s`），值和 SQL 分开传给数据库。唯一需要动态拼接的是 schema 名：`DROP SCHEMA`、`CREATE SCHEMA` 和 `search_path` 里的标识符，**标识符没法参数化**。它的做法是先用白名单正则校验：

```python
_SCHEMA_NAME = re.compile(r"^[a-z_][a-z0-9_]*$")
if not _SCHEMA_NAME.match(settings.db_schema):
    raise ValueError(f"invalid DB_SCHEMA {settings.db_schema!r}")
```

==值用参数化，标识符用白名单==，这是 SQL 注入防御的完整答案。全文检索的查询也是同样的思路：先用正则只提取字母和数字，再拼成 `to_tsquery` 的语法，用户输入里的特殊字符没有机会破坏查询语法。

**认证和密钥（A04、A07）**：LLMGateway 只存 API key 的哈希，管理接口要求 admin key；两个项目的密钥都通过环境变量或平台的 secrets 注入，不进代码仓库（见[认证与鉴权](/backend/auth)）。

**配置（A02）**：DocPilot 的 CORS 是白名单，不是 `*`。

### 可以改进的地方

**1. 访问控制（A01）**：DocPilot 是一个单用户的演示，**没有任何认证**，任何人都能列出、读取、删除所有文档。作为演示没有问题，但上线前这是第一件要补的事，而且要按[认证与鉴权](/backend/auth)里说的，把归属条件写进每一条查询，包括检索。

**2. 供应链（A03）**：

- Python 依赖在 `pyproject.toml` 里只写了下限（`fastapi>=0.115`），**也没有锁文件**。每次构建都可能装到不同的版本，包括某天被投毒的新版本。前端有 `package-lock.json`，后端也应该有（`uv lock`、`pip-tools` 生成带哈希的锁文件）。
- GitHub Actions 引用的是标签（`actions/checkout@v4`、`marocchino/sticky-pull-request-comment@v2.9.0`），标签可以被移动。第三方的 Action 尤其应该固定到具体的 commit SHA。

**3. 异常情况处理（A10）**：

- **错误信息外泄**：`/chat` 出异常时，会把 `f"{type(e).__name__}: {e}"` 原样发给前端显示。数据库的错误信息里可能带着表名、SQL 片段甚至连接串，应该只给用户一个通用的错误加上请求 id，详细信息只写进服务端日志。
- **资源耗尽**：上传接口先 `await file.read()` 把整个文件读进内存，**读完才检查**是否超过 20 MB。一个 2 GB 的上传会先把内存吃满。应该在读取之前检查 `Content-Length`，按块读取并累计计数，超过就中止；在反向代理上也设置请求体大小的上限。

**4. 解析不可信的文件**：上传的 PDF 由 pypdf 直接在 API 进程里解析。解析器处理恶意构造的文件时可能卡死或者吃光内存（这类库历史上出过不少拒绝服务的漏洞）。更稳妥的做法是放进有超时和内存上限的独立 worker 里解析（见[后台任务](/stack/mq-jobs)），并限制页数。

## AI 时代多出来的入口

| 入口 | 风险 | 对应的经典问题 |
|---|---|---|
| 上传的文档、检索到的网页 | 里面藏着给模型的指令 | 注入（见 [Prompt injection](/stack/sec-injection)） |
| 文档的元数据 | DocPilot 用 PDF 元数据里的标题作为文档标题，它会进入 `<chunk title="…">`，再进入模型的上下文 | 注入 |
| 模型的输出 | 输出被当成 HTML 渲染（XSS）、被当成 SQL 或 shell 命令执行 | 注入 / 不安全的输出处理 |
| agent 的「抓取 URL」工具 | 模型被诱导去请求 `http://169.254.169.254/` 之类的内网地址 | **SSRF**（现在属于 A01） |
| 第三方 MCP server、模型依赖 | 被投毒的工具描述、依赖包 | 供应链（A03） |

两条原则：

1. **模型的输出也是不可信的输入**：渲染前要转义（DocPilot 的前端用 React 渲染，默认会转义），执行前要校验；永远不要把模型的输出直接拼进 SQL 或 shell。
2. **agent 的工具要按服务端代码的标准审查**：抓取 URL 的工具要禁止内网地址（解析 DNS 之后再检查 IP，防止 DNS 重绑定），并限制协议、大小和超时（见 [Agent 权限与沙箱](/stack/sec-sandbox)）。

OWASP 还有一份专门的 **Top 10 for LLM Applications**，第一名就是 prompt injection，其他条目包括敏感信息泄露、不安全的输出处理、过度授权（excessive agency）等，后面几篇会分别展开。

## 追问

::: details 怎么彻底防住 SQL 注入？动态的表名、列名怎么办？
值永远用参数化查询（占位符），由驱动和数据库分开处理 SQL 与数据，不做字符串拼接。表名、列名、schema 名这类标识符没法参数化，就用白名单：只允许预先定义好的几个值，或者用严格的正则校验（DocPilot 用 `^[a-z_][a-z0-9_]*$` 校验 schema 名）。ORM 也要注意，原生 SQL 片段同样可能被注入。
:::

::: details OWASP Top 10:2025 和 2021 版相比有哪些变化？
SSRF 并入了 A01 访问控制失效（仍然排第一）；2021 的「易受攻击和过时的组件」扩大成了 A03 软件供应链失败，排名升到第三；安全配置错误升到第二；新增了 A10 异常情况处理不当；身份认证失败、日志与告警失败两类改了名字。
:::

::: details 什么是软件供应链攻击？后端项目应该怎么防？
攻击者不直接攻击你的代码，而是污染你依赖的东西：依赖包被投毒或被抢注、构建工具或 CI 动作被篡改。防御：用锁文件固定所有依赖的版本和哈希（DocPilot 的 Python 部分缺少这个）；尽量减少依赖；CI 里第三方的动作固定到 commit SHA；依赖漏洞扫描；镜像固定 digest；第三方 MCP server 也按依赖来审核。
:::

::: details 出错时应该把多少信息返回给客户端？
只返回一个通用的错误描述加上一个请求 id，详细的异常、堆栈、SQL 写进服务端日志，用请求 id 关联。DocPilot 的 `/chat` 会把异常的类型和消息原样发给前端，可能泄露数据库结构或内部地址，属于 A10 异常情况处理不当。同时要确保出错的路径同样默认拒绝，不会因为异常跳过了权限检查。
:::

::: details 一个上传接口要做哪些防护？
1. 认证和鉴权；
2. 在读取之前检查大小：看 `Content-Length`，按块读取并计数，超过就中止，反向代理也设上限（DocPilot 是先整个读进内存再检查）；
3. 按扩展名和实际内容双重校验类型；
4. 在隔离的 worker 里解析，带超时和内存上限，限制页数；
5. 文件名不要直接用于存储路径（防路径穿越）；
6. 必要时做病毒扫描。
:::

::: details agent 有一个「抓取网页」的工具，有什么安全风险？怎么防？
最主要的是 SSRF：模型可能被注入的内容诱导去请求内网地址，比如云厂商的元数据服务 `169.254.169.254`、内部管理接口。防御：只允许 http / https；先解析 DNS，再检查解析出的 IP 不在内网和保留地址段，防止 DNS 重绑定；限制响应大小、超时和重定向次数；抓回的内容同样当作不可信的数据，可能包含 prompt injection。
:::

::: details 为什么说模型的输出也是不可信的输入？
模型的输出受输入影响，而输入里可能有攻击者控制的内容（文档、网页、用户消息）。如果把输出直接当 HTML 渲染，就可能出现 XSS；直接拼进 SQL 或 shell 命令执行，就是注入。所以输出在渲染前要转义，在执行前要校验，结构化的输出要按 schema 校验，并且执行时只用最小的权限。
:::

## 参考

- [OWASP Top 10:2025](https://top10.owasp.org/2025/0x00_2025-Introduction)
- [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/)
- [OWASP Cheat Sheet Series: SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)、[SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)、[File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [GitHub: Security hardening for GitHub Actions（固定 SHA）](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- 实战代码：DocPilot `db.py`（`_SCHEMA_NAME`）、`retrieval/search.py`（`fts_query`）、`routes/documents.py`（上传）、`routes/chat.py`（错误信息）、`ingest/parse.py`、`pyproject.toml`、`.github/workflows/`；LLMGateway `gateway/auth.py`
