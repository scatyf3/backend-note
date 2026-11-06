---
title: Agent 权限与沙箱
---

# Agent 权限与沙箱

既然要假设模型一定会被注入或犯错，agent 能造成的最大损害就等于它的权限（OWASP 叫 excessive agency：功能过多、权限过大、自主性过高）。所以要：工具窄、面向任务、按风险分级；以用户身份执行，用委托授权换取短期、限定范围的 token，避免 confused deputy；代码在沙箱里执行（容器 < gVisor < microVM），默认禁止出站网络、文件系统临时且只读、密钥不进沙箱、限制资源和时间；高风险操作审批，操作尽量可逆，全程审计。

- **DocPilot 的参数校验**（`extra="forbid"`、`top_k ≤ 10`）和**生成内容的来源标记**（`kind='generated'`）都是最小权限的一部分。
- **沙箱默认禁止出站**：同时切断数据外泄和 SSRF。
- **预算也是安全边界**：每轮步数上限，LLMGateway 按 key 的 RPM、TPM 和月度预算。

笔记：[Agent 权限与沙箱](/ai/agent-sandbox)

**延伸阅读**：[OWASP LLM Top 10: Excessive Agency](https://genai.owasp.org/llm-top-10/)、[RFC 8693: Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
