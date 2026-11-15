# 11 · 测试清单

> 实跑证据。命令均在仓库根或 backend/ 下。Node：`C:\Users\Asus\.codex\workbuddy\bin\node.exe`（v24.21）。
> 不补造结果；缺真实环境验证标 Not Verified。

## 执行命令与总结果

```bash
# 后端（21 文件）
cd backend && node --test --test-force-exit
# → tests 112, pass 111, fail 0, skipped 1

# 后端类型检查
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   # exit 0

# 前端（16 文件）
cd web && node node_modules/vitest/vitest.mjs run
# → Test Files 16 passed, Tests 82 passed

# 迁移真实引擎验证
node backend/scripts/validate-migration.ts   # MIGRATION_VALIDATED 16/16

# 端到端冒烟（真实 DeepSeek）
node backend/scripts/smoke.ts   # SMOKE_PASS
```

## 后端测试文件（用例数实跑）

| 文件 | 用例 | 类别 |
|---|---|---|
| core/errors.test.ts | 2 | Unit |
| core/llm.test.ts | 6 | Unit |
| core/agent-loop.test.ts | 6 | Unit/Worker |
| core/agent-loop-context.test.ts | 2 | Integration（压缩） |
| core/context.test.ts | 9 | Unit（压缩/记忆/Builder） |
| core/ssrf.test.ts | 9 | Security |
| core/companion.test.ts | 5 | Security（授权） |
| core/companion-wss.test.ts | 5 | Integration（WSS） |
| core/capability.test.ts | 7 | Unit（Registry/Manifest） |
| core/evaluator.test.ts | 9 | Unit（Evaluator/门控） |
| runtime/runtime.test.ts | 4 | Unit（状态机/幂等键） |
| runtime/store.test.ts | 9 | Unit（InMemoryStore） |
| runtime/postgres-store.test.ts | 9 | Unit（SQL/映射，FakePool） |
| runtime/postgres-integration.test.ts | 1 | Database（**skipped**，Not Verified） |
| runtime/approval.test.ts | 4 | Security/Integration（审批 API） |
| runtime/worker.test.ts | 5 | Worker |
| runtime/worker-approval.test.ts | 6 | Worker/Security |
| runtime/worker-evaluator.test.ts | 4 | Worker/Evaluator |
| runtime/worker-manifest.test.ts | 3 | Worker/Capability |
| runtime/worker-companion.test.ts | 1 | Integration（WSS RPC） |
| api/api.test.ts | 6 | Integration（API/JWT/owner） |

## 按审计类别映射

| 类别 | 覆盖 | 状态 |
|---|---|---|
| Unit Tests | errors/llm/context/state-machine/idempotency/store/capability/evaluator | Complete |
| Integration Tests | agent-loop-context/companion-wss/worker-companion/api | Complete（进程内） |
| E2E Tests | scripts/smoke.ts（真实模型，API→Worker→succeeded） | Complete（单任务）；多步长任务 E2E **Not Verified** |
| Worker Tests | worker/worker-approval/worker-evaluator/worker-manifest | Complete |
| Database Tests | postgres-store（FakePool）+ validate-migration（PGlite 真实引擎） | Complete（PGlite）；生产库 **Not Verified** |
| RLS Tests | API owner 隔离（api.test.ts 跨用户 403）；PGlite 策略创建 | Partial；真实 Supabase RLS **Not Verified** |
| Recovery Tests | worker 崩溃重认领（模拟 lease 过期）/resume | Partial；真实进程 kill **Not Verified** |
| Security Tests | ssrf(9)/companion 授权(5)/approval(4)/worker-approval(6) | Complete（逻辑） |

## 未通过 / 跳过 / 未验证

- 跳过：postgres-integration.test.ts（1）——生产库直连封锁，自动 skip → **Not Verified**。
- 未通过：0。
- Not Verified（缺真实环境）：生产库 RLS/集成、真实进程 kill 恢复、多进程并发认领、Companion 真实跨主机/NAT、长任务 E2E、cost 预算硬停。

## 前端测试（web，82 通过）

含本轮新增 errors.test.ts、chatResilience.test.ts（[object Object] 修复回归）+ 既有 benchmark/context/scope/dedupe 等 16 文件。