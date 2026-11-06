---
title: 应用安全：OWASP
---

# 应用安全：OWASP

OWASP Top 10:2025 的前三名是访问控制失效（SSRF 并入了这一类）、安全配置错误和软件供应链失败，此外还新增了「异常情况处理不当」。几乎所有条目都能归结为两条：不信任边界外的输入，默认只给最小的权限。对应的做法是：值用参数化查询、标识符用白名单，每个对象都在服务端鉴权，安全的默认配置，用锁文件固定依赖，出错时不泄露细节、默认拒绝。AI 时代新增的不可信输入包括上传的文档及其元数据、检索内容、模型输出和 agent 工具。

- **DocPilot 做对的**：查询全部参数化，schema 名用正则白名单校验，CORS 白名单。
- **可以改进的**：没有认证；Python 依赖没有锁文件；`/chat` 把异常原样发给前端；上传先读进整个文件再查大小；在 API 进程内解析不可信的 PDF。
- **模型输出也是不可信的输入**；抓取 URL 的工具要防 SSRF。

笔记：[应用安全：OWASP Top 10 与 AI 时代的新入口](/backend/owasp)

**延伸阅读**：[OWASP Top 10:2025](https://top10.owasp.org/2025/0x00_2025-Introduction)、[OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/)
