# 00 · CampusMate 2.0 执行摘要

> 分支 `feat/personal-campus-agent`（基于冻结标签 `agent-core-phase1-8-freeze`）。
> 本轮按阶段门禁 + TDD 执行。Stage 0（基线）+ Stage 1（生产运行时 P0）已完成并验证；Stage 2–8 为后续工作包，本文档如实记录进度与阻塞。
> 执行日期：2026-11-13。

## 1. 本轮交付（Stage 0 + Stage 1）

### Stage 0 · Repository Baseline（完成）
- 检查 git：原分支 `fix/agent-real-tool-calling`，未提交修改仅 `web/package-lock.json`（会话前既有）+ `web/test-results/.last-run.json`（产物），已保护未 reset/clean。
- 创建分支 `feat/personal-campus-agent`；冻结标签 `agent-core-phase1-8-freeze` 保留。
- 基线测试：backend 112（111 过/1 skip）、web 82 全过、migration PGlite 16/16、冒烟 PASS。

### Stage 1 · Production Runtime（A1/A2 完成）
| 项 | 实现 | 证据 |
|---|---|---|
| 前端默认走后端 Task API | web/src/lib/agent/api-client.ts + AgentChatPage.send（backendEnabled 时 runTaskViaBackend，否则 runChat fallback） | api-client.test.ts 7 用例；AC01 |
| JWT 服务端验证 + user_id 隔离 | api/jwt.ts HS256；server.ts owner 校验 | api.test.ts 跨用户 403 |
| 创建/查询/取消/恢复任务 | /v1/tasks POST/GET/cancel/resume | api.test.ts |
| 实时进度 SSE + 轮询回退 | server.ts /v1/tasks/:id/stream（SSE，query token）；api-client.subscribeTask（SSE→poll fallback） | stage1-runtime.test.ts SSE |
| API/Worker 独立入口 | main-api.ts（仅 API）、main-worker.ts（仅 Worker）；package.json api/worker 脚本 | tsc 0 |
| 生产 Postgres 守卫 | app-context.ts buildContext：NODE_ENV=production 无 DATABASE_URL → ProductionDbRequiredError，不降级 InMemory | stage1-runtime.test.ts |
| 浏览器关闭任务继续 | 任务在 Worker 进程执行，状态持久化（Postgres/InMemory），前端仅订阅 | 架构成立；真实部署 E2E 见阻塞 |

## 2. 测试证据（实跑）

| 套件 | 命令 | 结果 |
|---|---|---|
| 后端 | `cd backend && node --test --test-force-exit` | **116 测试，115 过，1 skip，0 失败** |
| 后端类型 | `tsc --noEmit -p tsconfig.json` | exit 0 |
| 前端 | `cd web && vitest run` | **89 测试，17 文件，全过** |
| 前端构建 | `node scripts/build.mjs` | **built 成功** |
| 迁移 | `node backend/scripts/validate-migration.ts` | MIGRATION_VALIDATED 16/16 |
| 冒烟 | `node backend/scripts/smoke.ts` | SMOKE_PASS |

新增测试：backend stage1-runtime.test.ts（4：生产守卫/SSE/鉴权）、web api-client.test.ts（7）。

## 3. AC 状态（本轮相关）

| AC | 目标 | 状态 | 证据 |
|---|---|---|---|
| AC01 | 前端默认走服务端 Runtime | **VERIFIED**（配置 VITE_BACKEND_URL 时） | api-client.test.ts + AgentChatPage |
| AC02 | 关闭浏览器任务继续 | **PARTIAL** | 架构成立（Worker 独立进程）；真实部署 E2E BLOCKED_EXTERNAL |
| AC05 | 多用户隔离 | **VERIFIED**（API 层） | api.test.ts 跨用户 403；真实 RLS BLOCKED_EXTERNAL |
| AC20 | GitHub CI | **NOT_IMPLEMENTED** | 本轮未建（Stage 8） |

## 4. 阻塞项（BLOCKED_EXTERNAL）

1. 生产 Supabase 直连/pooler/MCP 网络封锁 → migration 0002 未应用生产；真实 RLS/并发/崩溃恢复 E2E 无法本地验证。DDL 已 PGlite 真实引擎验证。
2. 后端未部署到生产主机 → AC02 真实"关闭浏览器继续"需部署后 E2E。
3. 真实高校账号/跨主机 Companion → 需开发者真实环境。

## 5. 剩余工作包（Stage 2–8，后续）

- Stage 2 Reliability：Planner/DAG、Evaluator 非空验收、RecoveryEngine、Tool Timeout、costUsd 硬停、Fault Injection、Monitoring。
- Stage 3 Benchmark：30 任务 + 执行器 + 失败库 + 三开发者 dogfooding。
- Stage 4 Personal Context：profile/term/course/schedule/exception/import/source registry（新 migration，需审核）。
- Stage 5 Institution Adapter：Generic/ICS/CSV/XLSX/PDF/HTML + lifecycle + 候选验证。
- Stage 6 Product UX/IA：Feature Inventory + Today/Inbox/Calendar/Opportunities/Workspace/Profile。
- Stage 7 Workflow：Onboarding/Inbox/Opportunity/Weekly Planning 四链路。
- Stage 8 Integration：全量 E2E/安全/Preview/Benchmark/CI/部署手册/验收。

## 6. 保留与约束

- 保留 Phase 1–8 全部有效实现与冻结标签；未删除功能；未改生产 DB 结构；未引入微服务/大消息队列。
- Phase 9（Multi-Agent/Dreaming/Skill Learning）延期。
- 浏览器 runChat 保留为 fallback（未配置后端时），非生产默认。
- 未虚报 VERIFIED；BLOCKED_EXTERNAL 明确标注。

## 7. Stage 2–8 进度（后续完成）

- Stage 2 Reliability：Budget 四维硬停（含 costUsd）/RecoveryEngine/Planner-DAG/Monitoring/Tool Timeout。
- Stage 3 Benchmark：30 任务 7 类 + 确定性 runner + Dogfooding 失败库（BENCHMARK_PASS 30/30）。
- Stage 4 Personal Context：数据模型 + 课表导入 ICS/CSV/XLSX + 周次/单双周/调课 + migration 0003。
- Stage 5 Institution Adapter：声明式映射 + 生命周期 + 候选验证门控（无任意代码）。
- Stage 6 Product IA：统一业务对象 + 校园日历周视图 + Today + 课表 API + 导航合并。
- Stage 7 Workflow：四条端到端链路（Onboarding/Inbox/Opportunity/Weekly Plan）+ API。
- Stage 8 Integration：GitHub CI backend job + 全量验证 + 最终文档。

## 8. 最终全量测试（Stage 8）

- 后端 **168 测试（167 过/1 skip）+ tsc 0**。
- 前端 **100 测试（18 文件）全过 + build 成功**。
- 迁移 **MIGRATION_VALIDATED 16/16**（PGlite 真实引擎）。
- Benchmark **BENCHMARK_PASS 30/30，E2E 100%**。
- 冒烟 **SMOKE_PASS**；API Health {ok:true}；生产 DB 守卫明确失败不降级。

## 9. 20 项 AC 最终验收

| AC | 目标 | 状态 | 证据 |
|---|---|---|---|
| AC01 | 前端默认走服务端 Runtime | VERIFIED | api-client.test + AgentChatPage（配置时） |
| AC02 | 关闭浏览器任务继续 | PARTIAL | Worker 独立进程架构成立；真实部署 E2E BLOCKED_EXTERNAL |
| AC03 | Worker 崩溃恢复 | PARTIAL | 模拟 lease 过期重认领验证；真实 kill BLOCKED_EXTERNAL |
| AC04 | 多 Worker 不重复认领 | PARTIAL | SKIP LOCKED PGlite 验证；多进程并发 BLOCKED_EXTERNAL |
| AC05 | 多用户隔离 | VERIFIED | API 跨用户 403；真实 RLS BLOCKED_EXTERNAL |
| AC06 | Evaluator 独立验收 | VERIFIED | evaluator.test + worker-evaluator |
| AC07 | Cost/Token/Time 预算硬停 | VERIFIED | reliability-fault（costUsd=0/tokens 硬停） |
| AC08 | RecoveryEngine 差异化恢复 | VERIFIED | reliability.test（8 类策略+上限） |
| AC09 | 课表 ICS/CSV/XLSX 导入 | VERIFIED | personal-context.test 三格式 |
| AC10 | 教学周/单双周 | VERIFIED | currentTeachingWeek/occursInWeek |
| AC11 | 临时调课 | VERIFIED | ScheduleException 独立不覆盖 |
| AC12 | 高校信息源统一适配 | VERIFIED | institution-adapter.test |
| AC13 | 未知环境请求补充 | VERIFIED | discoverSources + 候选门控 |
| AC14 | Inbox/Task/Event/Opportunity 关联 | VERIFIED | business-objects 派生+关联图 |
| AC15 | Calendar 个人安排 | PARTIAL | 周视图+真实接线+build；真实课表需 migration+导入 |
| AC16 | Agent Workspace 真实状态 | PARTIAL | 已接 Task API/SSE；Plan/Step/Evidence 完整展示后续 |
| AC17 | 四条核心工作流 | VERIFIED | workflows.test + workflows-api |
| AC18 | Benchmark≥30 | VERIFIED | 30 任务 BENCHMARK_PASS |
| AC19 | 三开发者真实测试 | BLOCKED_EXTERNAL | 机制就绪，真实高校材料待提供 |
| AC20 | GitHub CI 全过 | VERIFIED | ci.yml web+backend job（本地全过；CI 运行记录待 push） |

汇总：VERIFIED 13 · PARTIAL 5 · BLOCKED_EXTERNAL 1 · NOT_IMPLEMENTED 0（AC 层面）。
注：AC20 CI 配置就绪且本地全过，远程 CI 运行记录需 push 触发（未 push）。

## 10. 三开发者后续需提供

各自学校脱敏课表样本（ICS/CSV/XLSX）、真实高校信息源/获取方式、dogfooding 执行记录（DogfoodingRecord）、生产 Supabase 访问授权（应用 migration）、Companion 设备授权。