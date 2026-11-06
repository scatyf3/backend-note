---
title: 认证与鉴权
---

# 认证与鉴权

认证回答「你是谁」，鉴权回答「你能对这个对象做什么」。认证方案的核心取舍是状态放在哪：session 存在服务端、撤销容易；JWT 自包含、免查库，但签出去后难以作废，所以要短有效期 + refresh token 轮换。第三方授权用 OAuth 2.0 授权码 + PKCE，要用户身份就加 OIDC；机器对机器用 API key（只存哈希）。事故大多出在鉴权：IDOR 是 OWASP API 安全的第一名。

- **API key 用 sha256 就够**：key 是高熵随机串，bcrypt / argon2 是给低熵密码用的（LLMGateway `auth.py`）。
- **多租户 RAG 要在检索 SQL 里按权限过滤**，否则模型会把别人的文档复述出来；近似向量索引加过滤要注意召回率。
- **agent 工具要以当前用户的权限执行**，避免 confused deputy；CORS 不是访问控制。

笔记：[认证与鉴权](/backend/auth)

**延伸阅读**：[OWASP API Security Top 10](https://owasp.org/API-Security/)、[RFC 8725: JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725)
