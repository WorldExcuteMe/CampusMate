# 06 · Database 与 RLS 审查

## Migration 状态

- `supabase/migrations/0001_init.sql`：业务 schema（已应用生产，历史）。
- `backend/migrations/0002_agent_runtime.sql`：agent_* 8 表 + RLS + 现有表增量 + VERIFIED 触发器。**未应用生产 Supabase**。

### 生产应用通道（本环境实测均封锁）
| 通道 | 结果 |
|---|---|
| 直连 db.<ref>.supabase.co:5432 | read ECONNRESET |
| pooler（14 区域探测） | tenant/user not found（区域不匹配） |
| MCP apply_migration | invocation did not complete（两次） |

→ 生产应用须经 Supabase Dashboard SQL Editor，或有直连权限的环境运行 `scripts/apply-migration.ts`。

## 真实引擎验证（PGlite WASM Postgres）

`scripts/validate-migration.ts` → **MIGRATION_VALIDATED 16/16**：
- agent_* 8 表创建（agent_goals/tasks/steps/events/checkpoints/tool_invocations/artifacts/evidence）。
- PostgresStore 完整契约：createTask/getTask/claimNext(SKIP LOCKED)/renewLease/recordInvocation(ON CONFLICT)/事件 seq/checkpoint/requestCancel。
- VERIFIED 触发器：无证据 VERIFIED 拒绝；evaluator+证据允许。
- inbox dedup_key 唯一约束：同 user 重复拒绝。

## RLS 设计（0002）

- agent_* 全启用 RLS；owner 只读策略 `auth.uid()=user_id`。
- agent_tasks owner insert（status='queued'）；状态/lease 改由服务端 service_role。
- 事件 append-only：无 update/delete 策略。
- 现有表：opportunities/reports/evidence 公共读（0001），写经服务端。

### RLS 验证状态
- PGlite 验证含 auth.uid() 桩，策略创建成功；**真实 Supabase RLS 跨用户访问未实测**（需生产库+真实 JWT）→ **Not Verified**。
- API 层 owner 隔离已验证（api.test.ts 跨用户 403）。
- Worker service_role 代码层强制 user_id（取自 task，不接受 args.user_id）。

## 缺口
- 生产库应用（Not Verified）。
- 真实 RLS 跨用户（Not Verified）。
- 记忆持久化表未含于 0002（Not Implemented，见 10）。
- `uid()`（web/src/lib/data/types.ts）非 UUID 缺陷：后端用 randomUUID 已修；前端旧路径仍存在（前端未接后端）。