import type { Card } from '@lib/flashcards'

const R = '/backend/auth'

export const cards: Card[] = [
  {
    id: 'auth-session-vs-jwt',
    deck: 'backend',
    topic: 'session / JWT',
    q: 'session 和 JWT 的根本区别是什么？各自适合什么场景？',
    a: '根本区别是**状态放在哪**：\n- **session**：客户端带一个引用（session id），服务端查存储。撤销容易（删记录立即生效），但每个请求都要查一次存储。适合单个 Web 应用、需要随时踢人下线的场景。\n- **JWT**：token 自包含、带签名，服务端验签就能信，不用查库。适合多服务分布式验证，但在 `exp` 之前**难以撤销**。',
    ref: `${R}#为什么-http-是无状态的`,
  },
  {
    id: 'auth-jwt-revoke',
    deck: 'backend',
    topic: 'JWT',
    q: 'JWT 签出去之后很难作废，工程上怎么处理撤销？',
    a: '1. **access token 设短有效期**（5–15 分钟），即使泄漏，影响时间也有限。\n2. 配合 **refresh token 续期，并且每次使用都轮换**：用一次就换发新的、作废旧的。发现旧 refresh token 被重复使用，说明它被偷了，**整条 token 链作废**。\n3. 必须立即撤销的场景（改密码、封号）维护一个 **denylist**，这又回到了查库。',
    ref: `${R}#jwt`,
  },
  {
    id: 'auth-jwt-alg',
    deck: 'backend',
    topic: 'JWT',
    q: 'JWT 有哪两个经典的验签漏洞？怎么防？',
    a: '1. **`alg: none`**：服务端接受不签名的 token，攻击者可以伪造任意用户。\n2. **算法混淆**：服务端本来用 RSA 公钥验 RS256，攻击者把 header 改成 HS256，再拿**公钥当 HMAC 密钥**签名，验签就通过了。\n防法：**服务端写死允许的算法**，不要相信 token header 里的 `alg`。另外记住 JWT 只签名不加密，payload 谁都能解码。',
    ref: `${R}#jwt`,
  },
  {
    id: 'auth-pkce',
    deck: 'backend',
    topic: 'OAuth',
    q: 'OAuth 授权码流程里的 PKCE 解决了什么问题？怎么做到的？',
    a: '**问题**：公共客户端（SPA、移动 App）没法安全地保存 client secret，授权码在重定向时又可能被截获，比如恶意 App 注册了同一个 URL scheme。\n**做法**：客户端先生成随机的 `code_verifier`，授权请求里只带它的哈希 `code_challenge`；用授权码换 token 时再提交原始的 verifier。截获了授权码的人没有 verifier，换不到 token。\nOAuth 2.1 要求**所有客户端**都用 PKCE；implicit 流程已废弃。',
    ref: `${R}#oauth-2-0-与-oidc`,
  },
  {
    id: 'auth-oauth-vs-oidc',
    deck: 'backend',
    topic: 'OAuth',
    q: 'OAuth 2.0 和 OIDC 有什么区别？「用 access token 判断用户身份」为什么是误用？',
    a: '- **OAuth 2.0** 是**授权**协议：应用能以什么 scope 访问用户的资源，产出 access token。\n- **OIDC** 在 OAuth 上加**身份**层：额外返回 `id_token`（JWT，说明用户是谁），并规定了 discovery 和 JWKS 端点。\naccess token 是给**资源服务器**用的，可能是签给别的客户端的，拿它当身份证明，可能被另一个应用拿来冒充用户。判断「是谁」要验证 `id_token`，并检查 `aud` 是不是自己。',
    ref: `${R}#oauth-2-0-与-oidc`,
  },
  {
    id: 'auth-api-key-sha256',
    deck: 'backend',
    topic: 'API key',
    q: 'LLMGateway 存 API key 时只存 sha256，为什么不用 bcrypt / argon2？',
    a: '**慢哈希是给低熵密码用的**：人类密码容易被字典暴力破解，所以要让每次猜测都很慢。\nAPI key 是几十字节的**高熵随机串**，暴力枚举本来就不可行，用快哈希就够了。而且**每个请求都要验证**，慢哈希会变成性能瓶颈。\n做法：算 `sha256(key)` → 查字典，一次哈希一次查表。配套做法：key 带前缀（`sk-gw-`）方便识别和做 secret scanning，admin key 和普通 key 分开授权。',
    ref: `${R}#api-key-机器对机器`,
  },
  {
    id: 'auth-idor',
    deck: 'backend',
    topic: '鉴权',
    q: '什么是 IDOR / BOLA？在代码层面怎么系统性地防？',
    a: '接口校验了登录，却没校验**这个对象属不属于你**：`GET /documents/123` 改成 `/124` 就能看别人的数据。它是 OWASP API Security Top 10 的**第一名**。\n系统性的防法：**把归属条件写进查询本身**，比如 `WHERE id = $1 AND tenant_id = $2`，而不是先查出来再在代码里判断，那样很容易漏写。也可以用数据库的行级安全（RLS），或者在数据访问层统一注入租户条件。',
    ref: `${R}#idor-最常见的鉴权漏洞`,
  },
  {
    id: 'auth-rag-acl',
    deck: 'backend',
    topic: 'AI 鉴权',
    q: '多租户 RAG 系统里，为什么「API 层做了鉴权」还不够？权限过滤应该放在哪？',
    a: '检索要是把别的租户的文档搜进上下文，模型会**把内容复述出来**，鉴权就被绕过了，而所有 API 层面的检查都「通过」了。\n过滤要**写进检索 SQL 本身**：chunk 带上 `tenant_id` / ACL，向量检索和全文检索都按它过滤。\n坑：HNSW 这类近似索引先找最近邻再过滤，条件严格时**召回率暴跌**，可以用 pgvector 0.8 的 iterative index scan，或者按租户分区、分开建索引。',
    ref: `${R}#_1-rag-检索必须按权限过滤`,
  },
  {
    id: 'auth-confused-deputy',
    deck: 'backend',
    topic: 'AI 鉴权',
    q: 'agent 有一个 `create_page` 工具，可以往文档库写东西。在多用户系统里，它应该以谁的身份执行？为什么？',
    a: '应该以**发起对话的用户**的身份和权限执行，而不是服务自己的高权限账号。\n否则就是 **confused deputy**：用户本身没有写权限，却能通过对话（或者被注入的指令）诱导 agent 替他写。\n做法：把用户身份和 scope 一路传到工具执行层，工具内部按用户权限检查；高风险的写操作再加人工确认。',
    ref: `${R}#_2-agent-的工具要代表用户执行-而不是以超级用户的身份执行`,
  },
]
