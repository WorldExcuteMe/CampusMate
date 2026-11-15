# MIGRATION_PLAN · 渐进式重构（Phase 0–9）

> 提案规范，未实现。原则：不推翻现有有效功能；Feature Flag + 独立分支；保持产品 API 兼容；重大 DB 迁移先方案后确认；每阶段 TDD + 验收 + 回滚。
> 现状地基（保留）：有界循环、原生 tool_calls、scope 掩码、错误边界、上下文压缩、Supabase Repository、Demo Repository。

## Phase 0 · 生产 Backend
- 目标：建立真实服务端 API，SPA 不再依赖本机 `/api/*`。
- 修改模块：新建 `backend/api`（Hono/Express）；前端 `VITE_BACKEND_URL`；`config.ts` 请求改打 Backend。
- 依赖：无（起点）。
- 实施任务：JWT 校验中间件；`/v1/health`；任务提交/查询桩；CORS；Docker 镜像；部署到小 VPS/Fly。
- TDD：JWT 验签单测；跨用户 403（T27）；health 集成测试。
- 验收：生产 Sites 可提交任务并查询（不跑 Loop）；密钥仅服务端。
- 回滚：Feature Flag `USE_BACKEND=false` 回退现浏览器模式；Backend 独立部署不影响前端。

## Phase 1 · Agent Core 解耦
- 目标：`runChat` 抽为纯 TS `agent-core` 模块，去浏览器依赖（localStorage/fetch 注入化）。
- 修改模块：`chat.ts`→`backend/agent-core`；`memory.ts`/`context.ts` 注入存储接口；`llm/proxy.ts` 服务端化。
- 依赖：Phase 0。
- 实施任务：依赖注入（Repository/LLM/Storage）；保留有界循环/scope/错误边界；浏览器与 Worker 共用同一 core。
- TDD：现 benchmark.test.ts 全绿（迁移后）；errors/chatResilience 回归。
- 验收：core 在 Node 与浏览器均可跑；82 测试不回归。
- 回滚：保留浏览器入口适配层，Flag 切换。

## Phase 2 · Task Runtime
- 目标：Goal/Task/Step 独立生命周期 + 结构化状态（事实来源）。
- 修改模块：新建 `task-runtime`；agent_goals/agent_tasks/agent_steps migration（待确认）。
- 依赖：Phase 1。
- 实施任务：状态机；Planner 生成 DAG（简单任务单 Step）；提交即写 queued。
- TDD：状态转换单测；DAG 拓扑校验；T01–T06。
- 验收：任务有独立 ID 与持久状态；不依赖聊天历史。
- 回滚：agent_* 表独立，不影响业务表；Flag 关闭回退单轮。

## Phase 3 · Background Worker
- 目标：单 Node Worker + Postgres 轻量队列（lease/heartbeat/claim）。
- 修改模块：新建 `worker`；agent_tasks lease 字段；`FOR UPDATE SKIP LOCKED`。
- 依赖：Phase 2。
- 实施任务：claim/heartbeat/finalize；限并发；进程自愈。
- TDD：队列认领并发测试；lease 过期重认领（T17）；SKIP LOCKED 直连验证。
- 验收：任务脱离 HTTP 存活；关闭浏览器不停（T16 前置）。
- 回滚：Worker 可停，任务留 queued；Flag 回退同步执行。

## Phase 4 · Checkpoint / Recovery
- 目标：checkpoint/resume，崩溃恢复，状态一致。
- 修改模块：agent_checkpoints/agent_events；task-runtime resume。
- 依赖：Phase 3。
- 实施任务：Step 边界/副作用后写 checkpoint；resume 还原 messages/进度；事件 seq 对齐。
- TDD：进程 kill 中途恢复（T16）；暂停/恢复（T21）；改目标（T20）。
- 验收：崩溃后从最后成功检查点续跑；重复副作用=0（配合 Phase 5）。
- 回滚：checkpoint 只增；Flag 关闭则从头重跑（幂等保护）。

## Phase 5 · Idempotency / Tool Security
- 目标：幂等键 + 唯一约束；本机能力移入 Companion；SSRF 加固；审批服务端强制。
- 修改模块：agent_tool_invocations；inbox dedup_key/opp content_hash；urlGuard 服务端复检；Capability runtime 过滤；Approval 流。
- 依赖：Phase 4。
- 实施任务：幂等键生成+查重；web_fetch DNS/重定向/字节超时；terminal/fs 云端禁用+Companion 审批；uid()→UUID。
- TDD：重放（T26）；SSRF（T23）；越权（T22/T25）；写库失败回归（T15）。
- 验收：重复触发不重复写；云端无本机能力；SSRF/审批硬指标 100%。
- 回滚：幂等约束可保留（无害）；Companion Flag 关闭回退 dev runtime（仅开发）。

## Phase 6 · Evaluator
- 目标：独立 Evaluator；禁止模型自判 VERIFIED。
- 修改模块：新建 `evaluator`；verify_opportunity→propose_verification；verification_reports 门控列。
- 依赖：Phase 5。
- 实施任务：acceptance 逐条核验；证据独立重抓比对；CompletionCertificate；DB 触发器门控。
- TDD：缺证据拒绝（T28）；自填 VERIFIED 拒绝（T29）；冲突识别（T30）；幻觉证据（T31）。
- 验收：无证据 VERIFIED 拒绝率 100%；幻觉证据率 0。
- 回滚：门控 Flag；旧报告保留 UNVERIFIED。

## Phase 7 · Capability Registry
- 目标：Capability Registry + Environment Manifest + Health Check + Companion 注册。
- 修改模块：新建 `capabilities`；Manifest 生成；Companion 出站注册。
- 依赖：Phase 5。
- 实施任务：Provider 注册；Manifest 决定工具集；能力缺失替代/报告；dev/cloud 严格区分。
- TDD：能力缺失发现（T09）；陌生环境（T07/T08）；Manifest 过滤。
- 验收：不假装具备能力；陌生环境可完成或明确报告。
- 回滚：Registry 退化为现 scope 过滤；Companion 可选。

## Phase 8 · Context / Memory
- 目标：五类记忆隔离 + Context Builder + 压缩配对完整性修复。
- 修改模块：agent_sessions/agent_messages/agent_skills；context.ts 按轮次组压缩；memory 服务端化。
- 依赖：Phase 4。
- 实施任务：分层注入（taskContext 恒注入）；groupTurns 原子压缩；artifact 引用；隔离键。
- TDD：超窗无孤儿 tool（T19）；跨会话/任务隔离；压缩不丢任务状态。
- 验收：长任务上下文不爆窗、配对完整；记忆不串用户。
- 回滚：保留现 trimToBudget 为 fallback；新分层 Flag。

## Phase 9 · Advanced Agent
- 目标：可靠单 Agent 之上，按需加 Parallel Research / Verification / Document / Review 子 Agent。
- 修改模块：subagent 编排（独立上下文/任务 ID/输入输出 Schema/预算/并发限制/父验收）。
- 依赖：Phase 6/7/8 稳定。
- 实施任务：确定性工作用代码工作流；语义判断才用 LLM 子 Agent；父 Agent 验收。
- TDD：子 Agent 预算/并发限制；父验收拒绝不合格子结果。
- 验收：子 Agent 不越预算、不跨用户；整体优于单 Agent 基线。
- 回滚：子 Agent Flag 关闭回退单 Agent。

## 阶段依赖图
```
P0 → P1 → P2 → P3 → P4 → P5 → P6
                  P4 → P8        P5 → P7
                              P6/P7/P8 → P9
```
第一阶段（P0–P6）聚焦可靠单 Agent Runtime；不引入多 Agent/Dreaming/Skill 自学习（P9 之后按需）。每阶段无测试不声称成功；重大 migration（agent_*）先方案待团队确认。