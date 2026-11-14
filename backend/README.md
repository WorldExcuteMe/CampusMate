# CampusMate Backend（Agent Core 2.0 · Phase 0–3 基础）

服务端 Agent 运行时。零运行时依赖（Node ≥24 直接运行 `.ts`，内置 `node --test`）。
对应 `docs/agent-core/` 架构规范；本目录是 MIGRATION_PLAN Phase 0–3 的可运行可测实现。

## 运行

```bash
# 一体化（API + Worker 同进程，默认内存 store，可立即演示）
LLM_API_KEY=sk-... SUPABASE_JWT_SECRET=... PORT=8788 node src/main.ts

# 启用 Postgres 持久化（Phase 2）：设置 DATABASE_URL 或 SUPABASE_DB_PASSWORD+SUPABASE_PROJECT_REF
DATABASE_URL=postgresql://postgres:PWD@db.REF.supabase.co:5432/postgres node src/main.ts

# 测试（无需安装依赖即可跑单元；pg 已入 dependencies）
node --test

# 类型检查
npm run typecheck
```

> 真实库集成测试 `postgres-integration.test.ts` 需直连 Postgres 且已应用 `migrations/0002`；
> 不可达/未迁移自动 skip。本开发环境直连 Supabase 5432 被重置（ECONNRESET），故默认 skip；
> 在有直连权限的环境应用迁移后即可运行。

## 环境变量

| 变量 | 说明 |
|---|---|
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | 服务端 LLM 密钥（绝不进前端）。缺省 Worker 不启动，API 仍可用 |
| `SUPABASE_JWT_SECRET` | 验 SPA 提交的 Supabase JWT（HS256） |
| `PORT` | API 端口，默认 8788 |
| `WORKER_CONCURRENCY` / `LEASE_TTL_MS` / `HEARTBEAT_MS` | Worker 并发/lease/心跳，默认 2/60000/15000 |

## API

```
GET  /v1/health                 存活（无需鉴权）
POST /v1/tasks                  提交任务（Bearer JWT）→ {taskId}
GET  /v1/tasks/:id              任务结构化状态（owner）
GET  /v1/tasks/:id/events       append-only 事件流（owner，?after=seq）
POST /v1/tasks/:id/cancel       协作式取消（owner）
```

## 模块

```
src/core/      types / errors / llm / agent-loop / cloud-tools / ssrf / companion / evidence / evaluator / verification / capability / manifest / tool-registry / context(压缩配对修复) / memory(五类隔离) / context-builder(分层)
src/runtime/   state-machine / store / postgres-store / sql / idempotency / approval / worker
src/api/       jwt(HS256) / server(http)
src/main.ts    一体化入口（按连接串选 memory/postgres）
migrations/    0002_agent_runtime.sql（提案，未应用）
```

## 已实现（Phase 0–3 + 2 PostgresStore + 5 安全 + 6 Evaluator + 7 Capability + 8 记忆/上下文）

- 服务端纯 Agent Loop（注入式）：有界循环、原生 tool_calls + JSON 回退、重复提醒、错误边界、预算硬停、审批暂停、**每轮按轮次组原子压缩**。
- Task Runtime：Goal/Task/Step 状态机、append-only 事件、Checkpoint、幂等键。
- PostgresStore（Phase 2）：事务 + `FOR UPDATE SKIP LOCKED` 队列、lease/heartbeat、`ON CONFLICT DO NOTHING` 幂等、行映射。
- SSRF 守卫（Phase 5）：guardUrl 增强 + DNS 解析后私网拦截 + safeFetch 重定向逐跳复检 + 字节/超时上限。
- 服务端强制审批（Phase 5）：ApprovalStore + 高危判定；未批准→needs_input 不执行；审批/恢复 API。
- Local Companion 能力分离（Phase 5）：CompanionRegistry + 授权范围强制；云端默认无本机能力。
- 独立 Evaluator（Phase 6）：按 AcceptanceCriterion 逐条核验；evidence_verified 独立重抓比对；propose_verification 自填 VERIFIED 降级 + 落库门控。
- Capability Registry + Environment Manifest（Phase 7）：Provider 注册/健康检查；任务前 buildManifest；能力缺失替代/明确报告；manifestTools 确定性门控；capabilities API。
- **上下文压缩配对修复（Phase 8）**：`groupTurns` 把 assistant(tool_calls)+tool 结果归为一组；`trimToBudget`/`composeContext` **按轮次组原子丢弃**，绝不拆散 tool_call↔result；`validatePairing` 校验无孤儿 tool；工具结果裁剪（spill）与历史压缩分离。
- **五类记忆隔离（Phase 8）**：`MemoryStore`（User/Session/Task/Episodic/Procedural），隔离键 user/session/task；跨用户/会话/任务检索默认禁止；Procedural 须 evaluator 验证。
- **Context Builder（Phase 8）**：分层组装（stableInstructions/taskContext/userProfile/relevantMemory/toolSchemas）；**taskContext 事实来源恒注入**不被压缩丢弃；记忆按 user+task 隔离检索；压缩摘要只引用不取代原始证据。
- Durable Worker：lease/心跳/崩溃重认领/checkpoint 恢复/协作取消/独立 Evaluator/Manifest 门控/分层上下文。
- API：JWT 验签、owner 隔离、CORS。错误序列化永不 `[object Object]`。

## 下一步（未实现，按 MIGRATION_PLAN）

- 应用 `migrations/0002` 到生产 Supabase（DDL 已 PGlite 真实引擎验证；本环境直连/pooler/MCP 网络封锁，经 dashboard 应用）。
- Phase 9：Advanced Agent（按需子 Agent，已跳过）。

## 迁移应用（migration 0002）

DDL 已在真实 Postgres 引擎（PGlite WASM）验证：`node scripts/validate-migration.ts` → **MIGRATION_VALIDATED（16/16）**，含 `FOR UPDATE SKIP LOCKED` 认领、`ON CONFLICT` 幂等、VERIFIED 触发器门控、dedup_key 唯一约束、PostgresStore 完整契约。

生产应用（本开发环境直连 5432 ECONNRESET / pooler 区域不匹配 / MCP 未完成，均网络封锁）：
```bash
# 有直连权限的环境：
DATABASE_URL=postgresql://postgres:PWD@db.REF.supabase.co:5432/postgres node scripts/apply-migration.ts
# 或 dashboard：Supabase Dashboard → SQL Editor → 粘贴 backend/migrations/0002_agent_runtime.sql → Run
```
应用后设 `DATABASE_URL` 启动 main.ts 即用 PostgresStore；`postgres-integration.test.ts` 不再 skip。

## Companion 出站 WSS

`CompanionServer`（附加 http upgrade，path=/companion）+ `CompanionClient`（用户本机出站连接）。流程：Companion 出站连接 → 设备令牌认证（`COMPANION_TOKENS`）→ 注册能力到 CompanionRegistry → 心跳；Worker 本机工具经 `CompanionServer.invoke` RPC 分派到 Companion 执行（授权+审批通过后）。云端默认无本机能力；断线自动重连。
```bash
# Backend：COMPANION_TOKENS='{"dev-token":{"userId":"u1","capabilities":["host.terminal"],"grantedScopes":{"terminalAllowlist":["ls"]}}}'
# Companion（用户本机）：CompanionClient({url:"wss://backend/companion", token:"dev-token", handleTool})
```

## 约束

本阶段未改前端、未改生产库。`migrations/0002_agent_runtime.sql` 为提案 DDL，**未应用**。