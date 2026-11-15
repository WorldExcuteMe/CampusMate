# 11 · 数据库迁移（Stage 8）

> Migration 0002/0003 状态：DDL 已 PGlite 真实引擎验证；生产未应用（BLOCKED_EXTERNAL）。

## Migration 清单

| 文件 | 内容 | 状态 |
|---|---|---|
| supabase/migrations/0001_init.sql | 业务 schema（profiles/inbox/opportunities/tasks/goals/plans...） | 已应用生产（历史） |
| backend/migrations/0002_agent_runtime.sql | agent_* 8 表 + RLS + VERIFIED 触发器 + inbox/opp 增量 | 提案，PGlite 验证 16/16，生产未应用 |
| backend/migrations/0003_personal_context.sql | user_institution_profiles/academic_terms/courses/course_schedules/schedule_exceptions/import_jobs + RLS + 回滚 | 提案，生产未应用 |

## Migration Review

- 0002：additive（create table if not exists / add column if not exists），不破坏 0001；VERIFIED 触发器门控（evaluator+证据）；幂等唯一约束。
- 0003：additive 新表，课程规则与调课分表，RLS owner，含 drop 回滚脚本。
- 真实引擎验证：`node backend/scripts/validate-migration.ts` → MIGRATION_VALIDATED 16/16（SKIP LOCKED/ON CONFLICT/触发器/唯一约束/PostgresStore 契约）。

## Backup Instructions

应用前：Supabase Dashboard → Database → Backups（或 `pg_dump` 直连导出）。生产数据备份后方可应用。

## Apply Instructions

本环境直连 5432 ECONNRESET / pooler 区域不匹配 / MCP 未完成（网络封锁）。应用路径：
1. Supabase Dashboard → SQL Editor → 依次粘贴 0002、0003 全文 → Run。
2. 或有直连权限环境：`DATABASE_URL=postgresql://... node backend/scripts/apply-migration.ts`（0002）；0003 同法。

## Post-migration Verification

```sql
select table_name from information_schema.tables where table_name like 'agent_%' or table_name in ('academic_terms','courses','course_schedules','schedule_exceptions','import_jobs','user_institution_profiles');
-- RLS：set request.jwt.claim.sub = '<uidA>'; select * from agent_tasks;（应只见 uidA）
```
应用后设 DATABASE_URL 启动 main-api/main-worker；postgres-integration.test.ts 不再 skip。

## Rollback Strategy

- 0003：`drop table if exists schedule_exceptions, course_schedules, courses, import_jobs, academic_terms, user_institution_profiles cascade;`
- 0002：drop agent_* 表 + 移除 inbox/opp 增量列 + drop enforce_verified_gate 触发器/函数。
- 回滚不影响 0001 业务数据。

## 安全门禁

不自动向生产应用未审核 migration；CI 仅 PGlite 验证；生产应用人工 Release Gate + 备份 + 授权。绝不伪造生产应用成功。