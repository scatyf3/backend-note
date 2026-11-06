---
title: 认证与鉴权：session、JWT、OAuth 与 API key
status: draft
tags: [auth, jwt, oauth, session, api-key, rbac]
difficulty: 3
order: 5
related: [/backend/api-design, /backend/network-tcp-http-tls, /backend/owasp, /ai/agent-sandbox, /ai/rag]
stack: [api-auth]
---

# {{ $frontmatter.title }}

## 一句话结论

**认证（authentication）**回答「你是谁」，**鉴权（authorization）**回答「你能对这个资源做什么」。两个不要混在一起，而且大多数事故出在后者。认证方案的核心取舍是==状态放在哪==：

- **session**：状态存在服务端，撤销容易，每次请求要查一次存储。
- **JWT**：状态写在 token 里，验签就够了，不用查库，但签出去之后很难提前作废。

第三方授权用 OAuth 2.0（授权码 + PKCE），要拿用户身份就在 OAuth 上加 OIDC；机器对机器用 API key 或 client credentials；服务之间用 mTLS。到了 AI 时代，鉴权多了一个新场景：==RAG 检索和 agent 工具调用都必须带着「当前用户」的权限去执行==，否则模型就成了绕过权限的后门。

## 为什么：HTTP 是无状态的

每个 HTTP 请求都是独立的，服务端要在每个请求上重新确认身份。只有两种办法：

1. 客户端带一个**引用**（session id），服务端拿它去查存储里的会话。
2. 客户端带一个**自证明的凭证**（签名过的 token），服务端验签就能信任里面的内容。

这就是 session 和 JWT 的根本区别，其他特性都是从这里推出来的。

## session + cookie

登录成功后，服务端生成一个随机的 session id，会话数据存进 Redis 或数据库，通过 cookie 下发给浏览器。

- **撤销容易**：删掉服务端的记录就立即生效，适合「踢下线」「改密码后所有设备登出」。
- **cookie 的安全属性**：
  - `HttpOnly`：JS 读不到，降低 XSS 偷 session 的风险；
  - `Secure`：只走 HTTPS；
  - `SameSite=Lax/Strict`：跨站请求不带 cookie，防 CSRF。
- **代价**：每个请求都要查一次 session 存储；跨域、移动端、服务之间调用都不方便。

## JWT

结构是 `header.payload.signature`，三段 base64url 编码。payload 里放 `sub`（用户）、`exp`（过期时间）、`scope` 等 claims。

- **签名不等于加密**：payload 谁都能解码查看，不要放敏感信息。
- **验签就能信**：服务端不用查库，适合微服务、多个服务共享一个身份系统。
- **难以撤销**：在 `exp` 之前，token 一直有效。通常的做法是：
  1. **access token 设短有效期**（5–15 分钟），配合 **refresh token** 续期；
  2. **refresh token 做轮换**：每次使用都换发新的，旧的作废；发现旧 token 被重复使用，就说明它被偷了，整条 token 链都作废；
  3. 真需要立即撤销的场景，维护一个 denylist（又回到了查库）。
- **经典漏洞**：
  - 接受 `alg: none`；
  - **算法混淆**：服务端用 RSA 公钥验签，攻击者把 `alg` 改成 HS256，再用公钥当 HMAC 密钥签名。

  防法是在服务端**写死允许的算法**，不要相信 header 里的 `alg`。

==选择口诀：要能随时撤销、只有一个 Web 应用，用 session；多服务分布式验证、能接受短期内无法撤销，用短期 JWT + refresh token 轮换。==

## OAuth 2.0 与 OIDC

OAuth 2.0 是**授权**协议：让用户授权第三方应用以有限的权限（scope）访问自己在某个服务上的资源，而不需要把密码交给第三方。

| 流程 | 用于 |
|---|---|
| **授权码 + PKCE** | Web 应用、SPA、移动端（OAuth 2.1 要求所有客户端都用 PKCE） |
| client credentials | 机器对机器，没有用户参与 |
| device code | 电视、CLI 这类不方便输入的设备 |
| ~~implicit~~ | 已废弃：token 直接放在 URL 片段里返回，容易泄漏 |

**PKCE 解决的问题**：公共客户端（SPA、移动 App）存不了 client secret。授权码在重定向时可能被截获，比如被恶意 App 注册了同一个 URL scheme。PKCE 让客户端先生成一个随机的 `code_verifier`，把它的哈希 `code_challenge` 放进授权请求；用授权码换 token 时再提交原始的 verifier。截获了授权码的人没有 verifier，就换不到 token。

**OIDC** 在 OAuth 之上加了身份层：额外返回一个 `id_token`（一个 JWT，说明「这个用户是谁」），并且规定了 discovery 文档和用来发布签名公钥的 JWKS 端点。「用 Google 登录」用的就是 OIDC。==OAuth 管「能做什么」，OIDC 管「是谁」。== 只用 OAuth access token 来判断用户身份是常见的误用。

## API key：机器对机器

API key 适合服务端调用：简单，能按 key 统计用量、限流和计费。LLMGateway 的实现（`gateway/auth.py`）是一个很好的样板：

- **只存哈希**：配置里只有 `sha256(secret)`，没有明文。数据库或配置泄漏后，攻击者拿到的只是哈希。
- **按哈希查表**：对请求带来的 key 算 sha256，然后查字典，一次哈希加一次字典查找就完成认证。
- **为什么这里用 sha256 而不是 bcrypt**：bcrypt、argon2 这类慢哈希是为**低熵的密码**设计的，用来抵抗暴力破解。API key 是几十字节的高熵随机串，暴力枚举本来就不可行，用快哈希没问题，而且每个请求都要验证，慢哈希会成为瓶颈。
- **带前缀**：`sk-gw-...` 这种前缀能一眼看出是哪个系统的 key，GitHub secret scanning 这类工具也能识别泄漏。
- **管理接口单独授权**：`/admin/*` 只接受 admin key，普通 key 只能调模型接口，这是最小权限原则。

## 鉴权模型

- **RBAC**（基于角色）：用户 → 角色 → 权限。简单，适合大多数后台系统。
- **ABAC**（基于属性）：根据用户、资源、环境的属性用规则判断（「部门相同且在工作时间内」）。灵活，但难以审计。
- **ReBAC**（基于关系）：根据「用户是这个文档所在文件夹的编辑者」这种关系图判断。Google Zanzibar 是代表，开源实现有 OpenFGA、SpiceDB。适合 Google Docs 式的共享模型。

### IDOR：最常见的鉴权漏洞

**IDOR / BOLA**（Broken Object Level Authorization，OWASP API Security Top 10 第一名）：接口校验了登录，却没校验「这个对象属不属于你」。`GET /documents/123` 改成 `/documents/124` 就能看到别人的文档。

防法：**每次按 id 访问对象时，都要把归属条件一起写进查询**，比如 `WHERE id = $1 AND tenant_id = $2`，而不是先查出来再在代码里判断（很容易漏写）。

## AI 时代多出来的鉴权问题

### 1. RAG 检索必须按权限过滤

DocPilot 是一个单用户的演示，没有认证，`/documents/{id}` 和检索都对所有文档开放。如果改成多租户，最容易漏掉的是**检索这一层**：用户 A 问问题，检索要是把用户 B 的私有文档搜进上下文，模型就会把它的内容复述出来，鉴权被绕过了，而所有 API 层面的检查都「通过」了。

做法是让 `chunks` 带上 `tenant_id` 或 ACL 信息，**在检索 SQL 里过滤**，而不是检索完再过滤。这里有个向量检索特有的坑：HNSW 这类近似索引先找最近邻再应用 `WHERE` 条件，过滤条件很严格时，可能只剩下很少的结果，召回率暴跌。pgvector 0.8 加了 iterative index scan 来缓解这个问题；租户多的话，也可以按租户分区，或者分开建索引，见 [Embedding 与向量索引](/stack/st-vector)。

### 2. agent 的工具要代表用户执行，而不是以超级用户的身份执行

DocPilot 的 `create_page` 工具会往文档库里写一篇新文档。在多用户系统里，这个写操作必须以**发起对话的用户**的身份和权限执行，不能用服务自己的高权限账号。否则就是经典的 **confused deputy**：用户本身没有写权限，却能诱导 agent 替他写。工具调用的权限模型、沙箱和人工审批，见 [Agent 权限与沙箱](/stack/sec-sandbox)。

### 3. 不要把 CORS 当成认证

DocPilot 配置了 `CORS_ORIGINS`，只允许它的前端域名跨域调用 API。但 CORS 只是**浏览器**执行的策略，限制的是网页里的 JS 能不能读取跨域响应。`curl` 和任何服务端代码都不受 CORS 约束。==CORS 不是访问控制==，API 该有的认证一个都不能少。

## 追问

::: details 认证和鉴权有什么区别？各举一个漏洞例子。
- **认证**确认身份（你是谁），漏洞例子：JWT 接受 `alg: none`，攻击者可以伪造任意用户的 token。
- **鉴权**确认权限（你能对这个对象做什么），漏洞例子：IDOR，登录后把 URL 里的 id 改一下就能看到别人的数据。

经验上，鉴权漏洞比认证漏洞多得多，因为每个接口、每个对象都要单独做检查。
:::

::: details session 和 JWT 怎么选？JWT 怎么撤销？
session 的状态在服务端，可以随时撤销，但每个请求都要查存储；JWT 自包含，验签就能用，适合多服务，但在过期之前无法作废。

JWT 的撤销方案：access token 设短有效期（几分钟），配合可轮换的 refresh token；refresh token 被重复使用就作废整条链；真正需要立即撤销的场景，再加一个 denylist。
:::

::: details OAuth 授权码流程里，PKCE 解决了什么问题？
公共客户端（SPA、移动 App）没法安全地保存 client secret，授权码在重定向时又可能被截获。PKCE 让客户端先生成一个随机的 `code_verifier`，授权请求里只带它的哈希；用授权码换 token 时必须提交原始的 verifier。截获了授权码的攻击者没有 verifier，就换不到 token。OAuth 2.1 要求所有客户端都使用 PKCE。
:::

::: details OAuth 和 OIDC 有什么区别？
OAuth 2.0 是授权协议，回答「这个应用能以什么权限访问用户的资源」，产出的是 access token。OIDC 是建立在 OAuth 上的身份层，额外返回一个 `id_token`（JWT），回答「这个用户是谁」。拿 access token 去判断用户身份是误用：token 可能是签给别的客户端的。
:::

::: details API key 应该怎么存？为什么 LLMGateway 用 sha256 而不是 bcrypt？
只存哈希，不存明文；请求来了就对 key 算哈希再查表。

用 sha256 是因为 API key 是高熵的随机串，暴力枚举本来就不可行，不需要慢哈希。bcrypt / argon2 是给低熵的人类密码用的，而且每次 API 请求都要验证，慢哈希会变成性能瓶颈。人类密码则必须用 argon2id / bcrypt 加盐。
:::

::: details 多租户的 RAG 系统，鉴权应该在哪一层做？
**在检索这一层，而且写进检索的 SQL 里。** 只在 API 层检查「用户能不能调用 /chat」是不够的：检索要是把别的租户的文档搜进上下文，模型会把内容复述出来。chunk 要带上 `tenant_id` 或 ACL，在向量检索和全文检索的查询里同时过滤。

要注意近似向量索引先找最近邻再过滤，条件严格时召回率会暴跌，可以用 pgvector 0.8 的 iterative scan，或者按租户分区、分开建索引。agent 的写工具也要以当前用户的权限执行，避免 confused deputy。
:::

::: details 配了 CORS 白名单，API 是不是就安全了？
不是。CORS 是浏览器执行的策略，只限制网页里的 JS 能不能读取跨域响应。curl、脚本、服务端代码完全不受影响。CORS 防的是「恶意网页借用户的浏览器读你的 API」，不能代替认证。和 CORS 相关的另一个问题是 CSRF：用 cookie 认证时，要靠 `SameSite` 或 CSRF token 防护。
:::

## 参考

- [RFC 6749: OAuth 2.0](https://www.rfc-editor.org/rfc/rfc6749)、[RFC 7636: PKCE](https://www.rfc-editor.org/rfc/rfc7636)、[OAuth 2.1 draft](https://oauth.net/2.1/)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [RFC 8725: JSON Web Token Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725)（算法混淆等陷阱）
- [OWASP API Security Top 10](https://owasp.org/API-Security/)（API1: BOLA）
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- Pang et al., [Zanzibar: Google's Consistent, Global Authorization System](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/)
- [pgvector: iterative index scans](https://github.com/pgvector/pgvector#iterative-index-scans)
- 实战代码：LLMGateway `gateway/auth.py`；DocPilot `app.py`（CORS）、`agent/tools.py`（`create_page`）
