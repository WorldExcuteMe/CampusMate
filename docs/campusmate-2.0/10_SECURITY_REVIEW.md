# 10 · 安全审查（Stage 8）

> 基于真实代码。安全门禁逐项核对。

## 已实现安全控制

| 项 | 实现 | 证据 |
|---|---|---|
| 密钥仅服务端 | LLM_API_KEY/SUPABASE_SERVICE_ROLE/JWT_SECRET 仅 backend env；前端恒 Mock/anon | config.ts、llm-proxy |
| JWT 服务端验证 | api/jwt.ts HS256 + exp 校验；每端点 owner 隔离 | api.test.ts 跨用户 403 |
| user_id 隔离 | TaskStore/PersonalContextStore 按 userId；Worker 取自 task 不接受 args | store/workflows 测试 |
| RLS | agent_*（0002）+ personal_context（0003）owner 策略 | migration + PGlite 验证 |
| SSRF 守卫 | ssrf.ts guardUrl + DNS 解析后私网拦截 + 重定向逐跳 + 字节/超时 | ssrf.test.ts(9) |
| 工具审批 | ApprovalStore 高危门控，未批准不执行；服务端强制非 Prompt | worker-approval.test.ts(6) |
| Companion 授权 | fsPaths/terminalAllowlist/qqGroups 范围强制；云端默认无本机能力 | companion.test.ts(5) |
| 适配器安全 | 声明式映射无 eval；候选须 fixture+用户确认才激活；不绕过认证/MFA | institution-adapter.test.ts(11) |
| 幂等 | agent_tool_invocations unique + ON CONFLICT；inbox dedup_key | postgres-store/PGlite |
| 错误可读 | errorMessage 永不 [object Object] | errors.test.ts |
| 生产 DB 守卫 | NODE_ENV=production 无 DB 明确失败，不降级 InMemory | stage1-runtime.test.ts |
| Prompt Injection | 工具/网页内容仅为数据；scope 掩码；Evaluator 独立核验 | scope/evaluator |

## 安全门禁核对（任务 §九）

1. 先检查现有 Migration/表结构/RLS ✔（0001/0002/0003）。
2. 复用已有业务模型 ✔（profiles/information_sources）。
3. 新 Migration 含回滚 ✔（0003 drop 脚本）。
4. 不破坏生产数据 ✔（未应用生产，additive DDL）。
5. 无备份授权不改生产 DB ✔（BLOCKED_EXTERNAL，未应用）。
6. 不输出密钥 ✔。
7. 前端不存 Service Role Key ✔。
8. 不跨用户访问 ✔（owner 隔离测试）。
9. 第三方网页内容不当可信指令 ✔（声明式映射 + scope）。

## 残留风险

- 真实 Supabase RLS 跨用户未实测（BLOCKED_EXTERNAL，PGlite 验证策略创建）。
- write_file/run_terminal 非幂等（靠审批+授权约束，内容哈希后续）。
- Companion 真实跨主机/NAT 未验证。
- 真实高校认证流程未实测（不绕过认证/MFA 设计已落实）。