# 02 · Phase 1–8 实现对照表

> Status 规则：Complete=代码+测试+运行证据齐全；Partial=部分实现/未接通；Not Implemented=未实现；Not Verified=代码存在但缺真实环境验证。禁止仅凭文件存在标 Complete。
> 路径相对仓库根。测试命令：`cd backend && node --test --test-force-exit`。

## Phase 1 · Agent Core 解耦

| 字段 | 内容 |
|---|---|
| Feature | 纯 Agent Loop（环境无关） |
| Specification | docs/agent-core/MIGRATION_PLAN.md Phase 1 |
| Implementation | backend/src/core/agent-loop.ts |
| Entry Point | runAgentLoop()；Worker.executeTask 调用 |
| Database | 无 |
| Tests | core/agent-loop.test.ts(6)、agent-loop-context.test.ts(2) |
| Evidence | 8 测试通过；冒烟 SMOKE_PASS |
| Status | **Complete**（后端层面） |

| Feature | 前端切换到后端 |
|---|---|
| Implementation | web/src/features/agent/AgentChatPage.tsx:90 仍 runChat |
| Status | **Not Implemented**（前端未接后端，仍浏览器循环） |

## Phase 2 · Task Runtime + PostgresStore

| 字段 | 内容 |
|---|---|
| Feature | Goal/Task/Step 状态机 + 事件 + 检查点 |
| Specification | TASK_RUNTIME_SPEC.md / DATABASE_SCHEMA_SPEC.md |
| Implementation | runtime/state-machine.ts、store.ts、postgres-store.ts |
| Entry Point | Worker.tick→claimNext；API POST /v1/tasks |
| Database | agent_tasks/steps/events/checkpoints（migration 0002） |
| Tests | runtime.test.ts(4)、store.test.ts(9)、postgres-store.test.ts(9) |
| Evidence | 22 测试通过；PGlite 真实契约 16/16 |
| Status | **Complete**（InMemory+PGlite）；生产库 **Not Verified** |

## Phase 3 · Background Worker

| 字段 | 内容 |
|---|---|
| Feature | lease 认领 + 心跳 + 限并发 |
| Specification | MIGRATION_PLAN Phase 3 |
| Implementation | runtime/worker.ts、store.claimNext（FOR UPDATE SKIP LOCKED） |
| Entry Point | Worker.tick()/run() |
| Database | agent_tasks.lease_* |
| Tests | worker.test.ts(5)、postgres-store.test.ts |
| Evidence | 认领/重认领/心跳测试通过；PGlite SKIP LOCKED 验证 |
| Status | **Complete**（逻辑）；多进程并发 **Not Verified** |

## Phase 4 · Checkpoint / Recovery

| 字段 | 内容 |
|---|---|
| Feature | checkpoint 写入 + resume + 崩溃重认领 |
| Implementation | store.writeCheckpoint/latestCheckpoint；worker.executeTask resume |
| Entry Point | hooks.onCheckpoint；claimNext 重认领 |
| Database | agent_checkpoints |
| Tests | store.test.ts、worker.test.ts（崩溃重认领）、worker-approval.test.ts（resume） |
| Evidence | 模拟 lease 过期重认领通过 |
| Status | **Partial**（真实进程 kill 恢复 **Not Verified**） |

## Phase 5 · Idempotency / Tool Security

| 字段 | 内容 |
|---|---|
| Feature | 幂等键 + SSRF 守卫 + 审批 + Companion 授权 |
| Specification | TOOL_EXECUTION_SPEC.md / CAPABILITY_SYSTEM_SPEC.md |
| Implementation | runtime/idempotency.ts、approval.ts；core/ssrf.ts、companion.ts |
| Entry Point | worker.wrappedExecuteTool；API /v1/approvals |
| Database | agent_tool_invocations unique(task_id,idempotency_key)；inbox dedup_key |
| Tests | ssrf.test.ts(9)、approval.test.ts(4)、companion.test.ts(5)、worker-approval.test.ts(6) |
| Evidence | 24 测试通过；PGlite 幂等唯一约束验证 |
| Status | **Complete**（逻辑）；幂等覆盖见 05（部分工具非幂等） |

## Phase 6 · 独立 Evaluator

| 字段 | 内容 |
|---|---|
| Feature | 独立证据核验 + VERIFIED 门控 |
| Specification | EVALUATION_SPEC.md |
| Implementation | core/evaluator.ts、evidence.ts、verification.ts |
| Entry Point | Worker.defaultEvaluate→Evaluator.evaluate |
| Database | verification_reports.evaluated_by/evidence_count + 触发器 |
| Tests | evaluator.test.ts(9)、worker-evaluator.test.ts(4) |
| Evidence | 13 测试通过；PGlite VERIFIED 触发器门控验证 |
| Status | **Complete** |

## Phase 7 · Capability Registry

| 字段 | 内容 |
|---|---|
| Feature | Registry + Environment Manifest + 工具门控 |
| Specification | CAPABILITY_SYSTEM_SPEC.md |
| Implementation | core/capability.ts、manifest.ts、tool-registry.ts |
| Entry Point | Worker.executeTask buildManifest→manifestTools；API /v1/capabilities |
| Database | 无 |
| Tests | capability.test.ts(7)、worker-manifest.test.ts(3) |
| Evidence | 10 测试通过；云端无本机能力/缺失替代验证 |
| Status | **Complete** |

## Phase 8 · Context / Memory

| 字段 | 内容 |
|---|---|
| Feature | 压缩配对修复 + 五类记忆隔离 + Context Builder |
| Specification | MEMORY_CONTEXT_SPEC.md |
| Implementation | core/context.ts、memory.ts、context-builder.ts |
| Entry Point | agent-loop trimToBudget；Worker buildContext |
| Database | 无（memory 仅 InMemory） |
| Tests | context.test.ts(9)、agent-loop-context.test.ts(2) |
| Evidence | 11 测试通过；无孤儿 tool/任务状态恒注入/隔离验证 |
| Status | 压缩 **Complete**；记忆隔离 **Complete**（InMemory）；记忆持久化 **Not Implemented** |

## 附加 · Companion 出站 WSS

| 字段 | 内容 |
|---|---|
| Feature | Companion 出站 WSS + RPC |
| Implementation | core/companion-server.ts、companion-client.ts |
| Entry Point | main.ts CompanionServer；Worker.companionServer.invoke |
| Tests | companion-wss.test.ts(5)、worker-companion.test.ts(1) |
| Evidence | 6 测试通过（进程内 WS） |
| Status | **Complete**（进程内）；真实跨主机/NAT **Not Verified** |

## 附加 · Migration 0002

| 字段 | 内容 |
|---|---|
| Feature | agent_* schema + RLS + 触发器 |
| Implementation | backend/migrations/0002_agent_runtime.sql |
| Tests | scripts/validate-migration.ts（PGlite） |
| Evidence | MIGRATION_VALIDATED 16/16 |
| Status | DDL **Complete**（真实引擎验证）；生产应用 **Not Verified**（网络封锁，未应用） |

## 汇总

Complete（有测试+运行证据）：Agent Loop、Task Runtime（InMemory/PGlite）、Worker 逻辑、SSRF/审批/授权、Evaluator、Capability、压缩、记忆隔离（InMemory）、Companion（进程内）、Migration DDL。
Partial：Checkpoint 真实崩溃恢复、前端接后端。
Not Implemented：前端切换后端、记忆持久化表。
Not Verified：生产库 RLS/集成、真实进程 kill 恢复、多进程并发、Companion 真实跨主机。