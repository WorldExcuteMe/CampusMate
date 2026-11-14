# ARCHITECTURE_REVIEW · 一致性审查 / 决策 / 证据

> 架构规范阶段收口。汇总九份文档，区分**已有代码证据**与**待验证假设**，给出选型理由与需团队决策项。
> 本阶段未改代码、未改库、未删功能。所有 DDL/接口为提案。

## 1. 交付物清单

| 文档 | 内容 |
|---|---|
| TARGET_ARCHITECTURE.md | 总体架构/模块/API/数据流/安全/部署 |
| DATABASE_SCHEMA_SPEC.md | agent_* 新表 DDL/RLS/幂等约束/复用判定 |
| TASK_RUNTIME_SPEC.md | Goal/Task/Step/DAG/状态机/Event/Checkpoint/Lease/Budget |
| TOOL_EXECUTION_SPEC.md | 工具契约/权限/审批/幂等/18 工具逐项评估 |
| CAPABILITY_SYSTEM_SPEC.md | Registry/Manifest/Health/Cloud/Companion/Dev |
| MEMORY_CONTEXT_SPEC.md | 五类记忆/Context Builder/压缩配对修复/隔离 |
| EVALUATION_SPEC.md | 独立 Evaluator/六类基准/32 测试任务 |
| DEPLOYMENT_SPEC.md | 部署拓扑/Secret/Edge 限制/最低成本/故障恢复 |
| MIGRATION_PLAN.md | Phase 0–9（目标/模块/依赖/TDD/验收/回滚） |
| 00/01/02 + source-snapshot.md | 前置取证（真实代码/失败分类/Trace/源码快照） |

## 2. 架构一致性审查（交叉核对）

1. **事实来源分离**：TASK_RUNTIME（结构化状态）↔ DATABASE（agent_tasks/steps）↔ MEMORY（Task State 层）↔ EVENT（追踪）↔ CHECKPOINT（恢复）五者定义一致，不混用。✓
2. **幂等闭环**：TOOL_EXECUTION（idempotency_key）↔ DATABASE（agent_tool_invocations unique + 业务唯一约束）↔ TASK_RUNTIME（at-least-once + 重认领跳过）一致。✓
3. **本机/云端分离**：CAPABILITY（runtime 过滤）↔ TOOL_EXECUTION（host_* 仅 Companion）↔ DEPLOYMENT（Companion opt-in）↔ TARGET（安全边界）一致。✓
4. **Evaluator 门控**：EVALUATION（拒绝无证据 VERIFIED）↔ TOOL_EXECUTION（propose_verification）↔ DATABASE（evaluated_by/evidence_count 门控）一致。✓
5. **预算/lease 独立**：TASK_RUNTIME（budget 管花费、lease 管执行权）↔ DATABASE（budget/usage/lease 字段）↔ DEPLOYMENT（WORKER_CONCURRENCY/LEASE_TTL）一致。✓
6. **迁移依赖**：MIGRATION P0→P9 依赖图与各 SPEC 模块对应；agent_* migration 集中在 P2/P4/P5/P6/P8，均标"待确认"。✓
7. **保留地基**：各 SPEC 明确保留有界循环/scope/错误边界/压缩/Repository/Demo，无推翻。✓

发现的不一致风险（已在文档标注）：
- DATABASE 指出 `uid()` 非 UUID 与全局表 RLS 写缺口 → MIGRATION P5 修复（uid→UUID、service_role 写）。需团队确认全局表写策略（§4 决策 D3）。
- MEMORY 压缩配对修复依赖 TASK_RUNTIME 的 checkpoint messages 快照格式 → 两者 ChatMessage 结构需统一（P1 解耦时定接口）。

## 3. 已有代码证据 vs 待验证假设

### 3.1 已有代码证据（真实文件:行）
| 结论 | 证据 |
|---|---|
| Agent Loop 完全在浏览器 | AgentChatPage.tsx:88 直接调 runChat；chat.ts:371 循环 |
| 生产 /api/* 无后端 | vite.config.ts:8（dev proxy）；serve.mjs:10（仅开发拉起）；functions/handler.ts（Hello 桩）；VITE_LLM_EDGE_URL 未定义 |
| 关闭浏览器即停 | runChat 局部 messages，无服务端 worker/checkpoint |
| uid() 非 UUID | data/types.ts:116 Math.random；DB id 列 uuid（0001_init.sql） |
| 全局表 anon 写被 RLS 拒 | 0001_init.sql:210-214 仅 select 策略；supabase.ts:154/187 insert |
| 幂等仅 localStorage | qq.ts:27/79 SEEN_KEY；dedupe.ts:108 非幂等 summary |
| URL Guard 不防重定向/DNS rebinding | urlGuard.ts:25-43 仅查初始 hostname；llm-proxy:321 redirect:follow 不复检 |
| 模型自判 VERIFIED 直接落库 | chat.ts:277-298 verify_opportunity |
| 压缩可能拆散 tool 配对 | context.ts:167-172 逐条 slice 丢弃 |
| [object Object] 已修 | 本会话 errors.ts + executeTool 边界；82 测试通过；真实模型冒烟 HTTP 200 |
| Auth=Supabase 邮箱密码 + auth.uid 隔离 | auth.tsx:37/71；0001_init.sql owner 策略 |
| 业务 goals/plans/tasks ≠ agent 运行时 | 0001_init.sql:116-153（用户域） |

### 3.2 待验证假设（需实验/团队确认，未证实）
| 假设 | 验证方式 | 风险 |
|---|---|---|
| Supabase 连接池下 `FOR UPDATE SKIP LOCKED` 可用 | 直连/事务模式实测（pooler transaction mode 可能限制） | 队列认领正确性 |
| 生产实际跑 Demo 模式（真实写因 uid/RLS 失败） | 真实 Supabase 登录跑 save_to_inbox 观察 | 影响 P0 优先级 |
| DeepSeek 原生 tool_calls 稳定支持 | 真实带 tools 调用验证（冒烟仅验证 chat） | Executor 工具路由 |
| Qoder Sites SPA 可跨域调外部 Backend | 部署后 CORS/HTTPS 实测 | 前端架构 |
| Companion 出站 WSS 在用户网络可用 | 真实 NAT 环境测试 | 本机能力接入 |
| 单 Worker 并发 2 + Postgres 队列满足规模 | 负载测试 | 容量规划 |
| 最低成本 ~$5/月 VPS 足够 | 实际部署观测 | 成本 |
| Evaluator 独立重抓证据的成本/时延可接受 | 基准 T31 实测 | 核验开销 |

## 4. 需团队决策的技术选型

1. **D1 Backend 框架/托管**：Hono vs Express；Fly.io vs Render vs 自管 VPS。建议 Hono + Fly（轻、冷启动快、成本低）。需确认预算与运维偏好。
2. **D2 队列实现**：纯 Postgres SKIP LOCKED（建议，零额外基础设施）vs Supabase pgmq 扩展。需先验证 §3.2 池行为；若 pooler 限制，用直连或 pgmq。
3. **D3 全局参考数据写策略**：opportunities/reports/evidence 保持全局共享 + service_role 写（建议，加 created_by 审计）vs 改为 owner 私有。涉及产品语义（机会是否全用户共享）。需产品决策。
4. **D4 Companion 形态**：独立桌面 app vs 现 llm-proxy.mjs 演进 vs 浏览器扩展。建议演进 llm-proxy（复用现有 QQ/微信工具）。需确认分发/授权 UX。
5. **D5 本机能力授权粒度**：每命令审批 vs 会话级授权 vs 工作区白名单。建议 fs 白名单 + terminal 每命令审批。需安全/UX 权衡。
6. **D6 Evaluator 证据核验强度**：每次独立重抓 vs 缓存快照比对。建议关键结论重抓、其余快照。需成本/可信权衡。
7. **D7 Migration 应用时机**：agent_* 表 DDL 需团队确认后经 supabase migration 应用（本阶段未应用）。需 DBA/负责人批准。

## 5. 为什么选择当前目标架构

1. **Modular Monolith 而非微服务**：现团队 3 人、小规模产品；单仓库模块边界足够清晰，避免分布式运维开销。Worker 可后续独立扩展（SKIP LOCKED 天然支持多 Worker）。
2. **Postgres 轻量队列而非 Redis/Kafka**：Supabase Postgres 已是唯一事实来源；lease+SKIP LOCKED 满足单 Worker 限并发；零额外基础设施、零额外成本、事务一致。
3. **Durable Worker 而非 Edge Function 长跑**：Edge 有时长/冷启动限制，无 lease/heartbeat 语义；独立 Node Worker 才能崩溃恢复、长任务、预算控制。
4. **Capability Adapter + Companion 而非云端直暴露本机**：现 llm-proxy 的 terminal/fs/QQ 是开发者本机能力，云端多用户绝不能默认暴露；Companion opt-in + 服务端审批是唯一安全形态。
5. **结构化状态/Event/Checkpoint 分离**：参考 DSH/LangGraph 的 durable execution 原则，但只取适合 CampusMate 的部分——状态为事实、事件为追踪、检查点为恢复，避免"聊天历史即状态"的脆弱性。
6. **独立 Evaluator**：执行 Agent 自判成功是现核验机制的根本缺陷（模型自填 VERIFIED 污染全局数据）；独立证据核验是可信产品的底线。
7. **保留成熟内核**：有界循环/scope 掩码/错误边界/压缩/Repository 已验证有效（82 测试），重构是"迁移+加固"而非推倒，降低风险。

## 6. 结论

 CampusMate 当前是"浏览器 + 开发者本机"的 Agent，无服务端运行时、无持久任务状态、无恢复、无独立验收。本规范给出从该现状升级到"独立服务端 + 持久状态 + 长任务恢复 + 可验证结果"的完整路径，全部基于真实代码取证，区分证据与假设，标注待决策项。下一步：团队确认 D1–D7 后，按 MIGRATION_PLAN Phase 0 启动（生产 Backend），每阶段 TDD + 验收 + 回滚，无测试不声称成功。