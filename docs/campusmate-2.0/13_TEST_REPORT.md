# 13 · 测试报告（Stage 8 全量）

> 实跑证据。Node v24.21。所有结果真实，未伪造。

## 全量结果

| 套件 | 命令 | 结果 |
|---|---|---|
| 后端单元/集成/安全/恢复 | `cd backend && node --test --test-force-exit` | **168 测试，167 过，1 skip，0 失败** |
| 后端类型检查 | `npm run typecheck`（tsc --noEmit） | **exit 0** |
| 前端单元 | `cd web && vitest run` | **100 测试，18 文件，全过** |
| 前端构建 | `node scripts/build.mjs` | **built 成功** |
| 迁移真实引擎 | `node backend/scripts/validate-migration.ts` | **MIGRATION_VALIDATED 16/16** |
| Benchmark | `node backend/scripts/run-benchmark.ts` | **BENCHMARK_PASS 30/30，E2E 100%** |
| 端到端冒烟 | `node backend/scripts/smoke.ts` | **SMOKE_PASS**（真实 DeepSeek） |
| API Health | `GET /v1/health` | **{ok:true,store:memory}** |
| 生产 DB 守卫 | `NODE_ENV=production node src/main-worker.ts`（无 DB） | **明确失败，不降级 InMemory** |

## 后端测试分类（168）

- Unit：errors/llm/context/state-machine/idempotency/store/capability/evaluator/budget/recovery/monitoring/planner/personal-context/schedule-import/institution-adapter/workflows。
- Integration：agent-loop-context/companion-wss/worker-companion/api/stage1-runtime/workflows-api。
- Worker：worker/worker-approval/worker-evaluator/worker-manifest/reliability-fault。
- Database：postgres-store（FakePool）+ validate-migration（PGlite 真实引擎）+ postgres-integration（skip，生产库 BLOCKED_EXTERNAL）。
- Security：ssrf(9)/companion(5)/approval(4)/worker-approval(6)/institution-adapter(11)。
- Recovery：reliability(8)/reliability-fault(3)/worker 崩溃重认领。
- Benchmark：benchmark.test(7) + 30 任务 runner。

## 前端测试（100）

- domain(11)：业务对象派生/周网格/单双周/空闲/今日。
- api-client(7)：后端 Task API/JWT/错误透传。
- 既有：errors/chatResilience/benchmark/context/scope/dedupe/classifier/extractor/orchestrator/reasoning/timeAware/urlGuard/attachIngest/integration/dshKernel/llmError。

## 跳过 / 未验证

- postgres-integration.test.ts（1 skip）：生产 Supabase 直连封锁 → BLOCKED_EXTERNAL。
- 真实进程 kill 恢复 / 多 Worker 并发 / 真实 RLS / Companion 跨主机 / 真实高校 E2E：BLOCKED_EXTERNAL。
- dedupe.test.ts 全量并发首跑偶发状态污染，隔离与重跑均通过（非确定性回归）。

## CI

`.github/workflows/ci.yml`：web job（build/test/e2e）+ backend job（typecheck/test/migration validation/benchmark smoke）。PR 须通过。生产部署人工 Release Gate（release.yml），不自动应用未审核 migration。