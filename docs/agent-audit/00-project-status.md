# 00 · 项目状态（Phase 1–8 Implementation Freeze）

> 审计准备阶段。本文档包基于真实代码与实跑证据，供独立技术审计。Status 严格区分 Complete / Partial / Not Implemented / Not Verified；未经验证不标 Complete。
> 审计日期：2026-11-13。冻结标签：`agent-core-phase1-8-freeze`。

## 1. 范围

- 已完成：MIGRATION_PLAN Phase 0–8（生产 Backend 骨架、Agent Core 解耦、Task Runtime、Background Worker、Checkpoint/Recovery、Idempotency/Tool Security、独立 Evaluator、Capability Registry、Context/Memory）+ migration 0002 真实引擎验证 + Companion 出站 WSS。
- 延期（不在本轮）：Phase 9 Advanced Agent（Multi-Agent / Dreaming / Skill Learning）。
- 本轮仅整理/检查/验证，无大规模重构、无 DB 结构改动、无删除功能。

## 2. 代码规模（真实）

- 后端 `backend/`：29 个源文件（非测试）+ 21 个测试文件；零运行时框架依赖（Node ≥24 直跑 `.ts`），运行时依赖仅 `pg`、`ws`；devDeps `typescript`/`@types/*`/`@electric-sql/pglite`。
- 前端 `web/`：React SPA（Qoder Sites 静态托管），仍含浏览器内 `runChat`（见 §4 关键事实）。
- 设计文档 `docs/agent-core/`：00–02 取证 + 9 份 SPEC + ARCHITECTURE_REVIEW + source-snapshot。

## 3. 测试与运行证据（实跑）

| 套件 | 命令 | 结果 |
|---|---|---|
| 后端单元/集成 | `cd backend && node --test --test-force-exit` | **112 测试，111 通过，1 跳过，0 失败** |
| 后端类型检查 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0** |
| 前端单元 | `cd web && node node_modules/vitest/vitest.mjs run` | **82 测试，16 文件，全通过** |
| 迁移真实引擎验证 | `node backend/scripts/validate-migration.ts` | **MIGRATION_VALIDATED 16/16**（PGlite WASM Postgres） |
| 端到端冒烟（真实模型） | `node backend/scripts/smoke.ts` | **SMOKE_PASS**（DeepSeek HTTP 200，task succeeded） |

跳过项：`postgres-integration.test.ts`（需真实 Supabase 直连，本环境网络封锁，自动 skip）→ 标记 **Not Verified**（生产库）。

## 4. 关键事实（审计必读）

1. **前端未接后端**：`web/src/features/agent/AgentChatPage.tsx:90` 仍调用浏览器内 `runChat`。后端 `backend/` 是**并行实现**，未替换前端调用路径。因此"Task Runtime 独立于浏览器"在**后端层面成立**，但**生产前端仍依赖浏览器生命周期** → 整体标 **Partial**。
2. **migration 0002 未应用到生产 Supabase**：本环境直连 5432 `ECONNRESET`、pooler 区域不匹配、MCP `apply_migration` 未完成（网络封锁）。DDL 已在 PGlite 真实 Postgres 引擎验证 16/16；生产应用须经 dashboard 或有直连权限的环境。生产库相关能力标 **Not Verified**。
3. **崩溃恢复为模拟验证**：lease 过期重认领经单元/PGlite 测试验证；**真实进程 kill 后恢复未执行** → 标 **Not Verified**（真实崩溃）。
4. **Memory 仅 InMemory**：五类记忆隔离经 InMemory 测试验证；**无持久化记忆表**（migration 0002 不含 memory 表）→ 持久化标 **Not Implemented**。
5. **Companion WSS 进程内验证**：server+client 端到端经进程内 WS 测试；**真实跨主机/NAT 部署未验证** → 标 **Not Verified**（真实网络）。

## 5. 冻结说明

- 版本标签 `agent-core-phase1-8-freeze` 指向 Phase 1–8 完成提交。
- 工作区重要修改已提交（backend 源/迁移/脚本、docs、web 修复）；node_modules/coverage/测试产物经 .gitignore 排除。
- 暂停 Multi-Agent/Dreaming/Skill Learning；不删除任何现有代码。

## 6. 文档包索引

00 状态 · 01 总体架构 · 02 Phase 对照表 · 03 Task Runtime · 04 Worker · 05 Tool Execution · 06 Database/RLS · 07 Checkpoint/Recovery · 08 Evaluator · 09 Capability · 10 Memory/Context · 11 测试清单 · 12 部署 · 13 已知问题。