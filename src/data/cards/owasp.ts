import type { Card } from '@lib/flashcards'

const R = '/backend/owasp'

export const cards: Card[] = [
  {
    id: 'owasp-2025-changes',
    deck: 'backend',
    topic: 'OWASP',
    q: 'OWASP Top 10:2025 的前三名是什么？和 2021 版相比有哪些主要变化？',
    a: '前三名：**A01 访问控制失效**、**A02 安全配置错误**、**A03 软件供应链失败**。\n主要变化：\n1. **SSRF 并入了 A01**；\n2. 2021 的「易受攻击和过时的组件」扩大成 **A03 软件供应链失败**，排名升到第三；\n3. 新增 **A10 异常情况处理不当**；\n4. 身份认证失败、日志与告警失败两类改了名字。\n加密失败、注入、不安全的设计都往后移了。',
    ref: `${R}#owasp-top-10-2025`,
  },
  {
    id: 'owasp-sqli-identifiers',
    deck: 'backend',
    topic: '注入',
    q: '怎么彻底防住 SQL 注入？动态的 schema 名、表名没法参数化，DocPilot 是怎么处理的？',
    a: '**值**永远用参数化查询：驱动把 SQL 和数据分开传给数据库，不做字符串拼接（DocPilot 全部用 `%s` / `%(name)s` 占位符）。\n**标识符**（表名、列名、schema 名）没法参数化，就用**白名单**：只允许预定义的几个值，或者用严格的正则校验。DocPilot 用 `^[a-z_][a-z0-9_]*$` 校验 `DB_SCHEMA`，不通过就直接报错，然后才拼进 `DROP SCHEMA` / `search_path`。\n口诀：**值用参数化，标识符用白名单**。',
    ref: `${R}#做对的地方`,
  },
  {
    id: 'owasp-supply-chain',
    deck: 'backend',
    topic: '供应链',
    q: '什么是软件供应链攻击？DocPilot 在这方面有哪些可以改进的地方？',
    a: '攻击者不直接攻击你的代码，而是**污染你依赖的东西**：依赖包被投毒或抢注、构建工具或 CI 动作被篡改。\nDocPilot：\n1. `pyproject.toml` 里的依赖只写了下限（`fastapi>=0.115`），**没有锁文件**，每次构建都可能装到不同的版本（前端有 `package-lock.json`）。应该生成带哈希的锁文件；\n2. GitHub Actions 引用的是**可以被移动的标签**（`@v4`、`@v2.9.0`），第三方的 Action 应该固定到 commit SHA。',
    ref: `${R}#可以改进的地方`,
  },
  {
    id: 'owasp-error-leak',
    deck: 'backend',
    topic: '异常处理',
    q: '出错时应该返回多少信息给客户端？DocPilot 的 `/chat` 在这里有什么问题？',
    a: '只返回**通用的错误描述加一个请求 id**，详细的异常、堆栈、SQL 写进服务端日志，用请求 id 关联。\nDocPilot 的 `/chat` 出异常时，把 `f"{type(e).__name__}: {e}"` **原样发给前端**显示。数据库的错误信息里可能有表名、SQL 片段甚至连接串，这属于 2025 版新增的 **A10 异常情况处理不当**。\n还要保证出错的路径同样**默认拒绝**，不会因为异常跳过了权限检查。',
    ref: `${R}#可以改进的地方`,
  },
  {
    id: 'owasp-upload',
    deck: 'backend',
    topic: '上传',
    q: '一个文件上传接口要做哪些防护？DocPilot 的上传接口有什么问题？',
    a: '1. 认证和鉴权；\n2. **读取之前检查大小**：看 `Content-Length`，按块读取并计数，超过就中止；反向代理也设上限；\n3. 按扩展名和实际内容双重校验类型；\n4. 在有超时和内存上限的**隔离 worker** 里解析，限制页数；\n5. 文件名不直接用作存储路径（防路径穿越）。\nDocPilot：先 `await file.read()` 把**整个文件读进内存**，读完才检查 20 MB 的上限；而且直接在 API 进程里用 pypdf 解析不可信的 PDF。',
    ref: `${R}#可以改进的地方`,
  },
  {
    id: 'owasp-ssrf-agent',
    deck: 'backend',
    topic: 'SSRF',
    q: 'agent 有一个「抓取网页」的工具，主要的安全风险是什么？怎么防？',
    a: '主要风险是 **SSRF**（2025 版归入 A01）：模型被注入的内容诱导去请求**内网地址**，比如云厂商的元数据服务 `169.254.169.254`、内部的管理接口。\n防御：\n1. 只允许 http / https；\n2. **先解析 DNS，再检查 IP** 不在内网和保留地址段（防 DNS 重绑定）；\n3. 限制响应大小、超时、重定向次数；\n4. 抓回的内容同样当作**不可信的数据**，它可能包含 prompt injection。',
    ref: `${R}#ai-时代多出来的入口`,
  },
  {
    id: 'owasp-llm-output',
    deck: 'backend',
    topic: 'AI 安全',
    q: '为什么说模型的输出也是不可信的输入？AI 应用里还有哪些新的不可信输入？',
    a: '模型的输出受输入影响，而输入里可能有**攻击者控制的内容**。输出直接当 HTML 渲染就可能 **XSS**，直接拼进 SQL 或 shell 就是**注入**。所以渲染前要转义（DocPilot 用 React，默认转义），执行前要校验，结构化输出按 schema 校验。\n**新的不可信输入**：上传的文档、检索到的网页、**文档元数据**（DocPilot 用 PDF 元数据的标题，它会进入 `<chunk title>`，也就进了模型上下文）、第三方 MCP server 的工具描述。',
    ref: `${R}#ai-时代多出来的入口`,
  },
]
