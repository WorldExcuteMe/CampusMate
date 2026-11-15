# TARGET_ARCHITECTURE · CampusMate Agent Core 2.0

> 架构规范阶段（非实现）。基于真实仓库取证：分支 `fix/agent-real-tool-calling`。所有"现状"结论附 `文件:行`；所有"目标"为提案，未改代码/未改库。
> 形态：**Modular Monolith + Durable Worker + Capability Adapter**。持久化复用 Supabase PostgreSQL。第一阶段单 Node Worker，不引入 Redis/Kafka/微服务。

## 1. 总体架构图

```
┌────────────────────────── 用户浏览器 ──────────────────────────┐
│ Qoder Sites 静态 SPA (React)                                    │
│  - AuthProvider(Supabase Auth, auth.uid)   web/src/app/auth.tsx │
│  - ChatUI：提交目标 / 订阅任务进度(SSE/轮询) / 展示结果          │
│  - 不再在浏览器跑 Agent Loop（runChat 迁出）                     │
└───────────────┬───────────────────────────────┬────────────────┘
                │ HTTPS + Supabase JWT           │ HTTPS + JWT（可选，仅 opt-in 用户）
                ▼                                ▼
┌───────────────────────────┐      ┌──────────────────────────────┐
│ Backend API (Node, 模块化) │      │ Local Companion (桌面, opt-in)│
│  api 模块：REST/SSE        │◄────►│  由 dev/llm-proxy.mjs 演进     │
│  - POST /goals /tasks      │ 出站 │  QQ/微信摄取 / terminal / fs   │
│  - GET /tasks/:id /events  │ 长连 │  仅本机能力，用户明确授权      │
│  - POST /tasks/:id/cancel  │      │  云端默认不可见这些能力        │
│  - POST /approvals/:id     │      └──────────────────────────────┘
│  auth 校验：验 Supabase JWT │
└───────────────┬───────────┘
                │ 读写（service_role，仅服务端）
                ▼
┌──────────────────────────────────────────────────────────────┐
│ Supabase PostgreSQL（唯一事实来源）                            │
│  业务域：profiles/inbox_items/opportunities/tasks(用户待办)…   │
│  Agent 运行时（新增）：agent_tasks/agent_steps/agent_events/   │
│    agent_checkpoints/agent_tool_invocations/agent_artifacts/   │
│    agent_evidence                                              │
│  轻量队列：agent_tasks + FOR UPDATE SKIP LOCKED + lease        │
└───────────────┬──────────────────────────────────────────────┘
                │ 认领任务（lease/heartbeat）
                ▼
┌──────────────────────────────────────────────────────────────┐
│ Durable Worker (Node, 单进程, 限并发)                          │
│  agent-core 模块：Planner → Executor(有界循环) → Evaluator     │
│  task-runtime：状态机 / Checkpoint / Resume / Retry / Budget   │
│  capabilities：Registry + Adapter（cloud / local-companion）   │
│  llm：Provider Adapter（密钥服务端持有）                       │
│  memory：User/Session/Task/Episodic/Procedural 隔离            │
└──────────────────────────────────────────────────────────────┘
```

Backend API 与 Worker 同仓库（`backend/`），第一阶段可同机两进程；共享 `agent-core`/`task-runtime`/`capabilities`/`llm` 模块代码。Supabase Edge Functions 仅承担认证辅助/极短请求（可选），**不承担长任务 Worker**（见 DEPLOYMENT_SPEC §Edge 限制）。

## 2. 模块职责

| 模块 | 职责 | 现状来源 | 目标 |
|---|---|---|---|
| `api` | HTTP 边界、JWT 校验、任务提交/查询/取消/审批、SSE 进度 | 无（现全在浏览器） | 新建 Node Hono/Express |
| `agent-core` | Planner/Executor/Evaluator、有界循环 | `chat.ts runChat` | 抽出为纯 TS 模块，去浏览器依赖 |
| `task-runtime` | Goal/Task/Step 状态机、队列、lease/heartbeat、checkpoint/resume、budget | 无 | 新建 |
| `capabilities` | Capability Registry、Provider Adapter、Environment Manifest、Health Check | `scope.ts`+`tools.ts` 雏形 | 新建注册表，工具按 runtime 分类 |
| `llm` | Provider Adapter、退避重试、错误分类 | `llm/proxy.ts`+`errors.ts`+`dev/llm-proxy.mjs` | 服务端化，密钥仅服务端 |
| `memory` | 五类记忆隔离、Context Builder、压缩 | `memory.ts`(localStorage)+`context.ts` | 服务端持久化 + 分层 |
| `tools` | Tool Registry、Schema、执行边界、幂等、执行记录 | `chat.ts dispatchTool`+`tools.ts` | 统一契约 + 幂等 + 权限 |
| `repository` | 业务数据访问 | `data/supabase.ts`+`demo.ts` | 保留接口，服务端用 service_role |
| `local-companion` | 本机能力（QQ/微信/terminal/fs） | `dev/llm-proxy.mjs` | 演进为 opt-in 桌面伴侣 |

## 3. API 边界（Backend ↔ SPA）

所有端点要求 `Authorization: Bearer <Supabase access_token>`，Backend 用 Supabase JWT secret 验签得 `auth.uid()`，所有读写按该 uid 隔离。

```
POST /v1/goals                 创建目标（规范化 + 生成 Task）
POST /v1/tasks                 直接提交任务（goal 可选）
GET  /v1/tasks/:id             任务结构化状态（事实来源）
GET  /v1/tasks/:id/events      append-only 事件流（SSE 或分页）
POST /v1/tasks/:id/cancel      请求取消（协作式，Worker 在检查点响应）
POST /v1/tasks/:id/resume      从最后 checkpoint 恢复
POST /v1/approvals/:id         人工审批（高危工具/超预算续跑）
GET  /v1/capabilities          当前用户 Environment Manifest（可用能力+健康）
GET  /v1/health                存活/就绪
```

业务数据（inbox/opportunities/tasks 待办）仍可由 SPA 经 Supabase anon+RLS 直读；**写全局参考数据（opportunities/reports/evidence）改由 Backend service_role 执行**（现状 anon 无 insert 策略，见 DATABASE_SCHEMA_SPEC §RLS 缺口）。

## 4. Backend 架构

Modular Monolith：单 Node 服务，模块以文件夹边界 + 依赖注入隔离，不拆微服务。`api` 进程无状态、可水平扩展；所有持久状态在 Postgres。请求路径只做"提交/查询/审批"，**不在 HTTP 请求内跑 Agent Loop**（解决"任务依赖一次 HTTP 存活"）。提交即写 `agent_tasks(status=queued)` 返回 `taskId`，Worker 异步认领。

## 5. Worker 架构

单 Node 进程，`WORKER_CONCURRENCY`（默认 2）限并发。循环：
1. `claim`：`SELECT … FROM agent_tasks WHERE status='queued' OR (status='running' AND lease_expires_at<now()) ORDER BY priority,created_at FOR UPDATE SKIP LOCKED LIMIT n`，置 `status=running, lease_owner, lease_expires_at=now()+lease_ttl`。
2. `heartbeat`：执行中每 `heartbeat_interval` 续 lease；崩溃后 lease 过期，任务被其他 Worker 重新认领（at-least-once）。
3. `execute`：从最后 checkpoint 恢复 messages/step 进度，跑有界 Executor 循环；每步写 `agent_steps`/`agent_events`/`agent_tool_invocations`，阶段末写 `agent_checkpoints`。
4. `evaluate`：独立 Evaluator 校验验收条件+证据，通过才 `succeeded`。
5. `finalize`：写终态 + 释放 lease。

at-least-once + 幂等键 ⇒ 副作用 exactly-once（见 TOOL_EXECUTION_SPEC §Idempotency）。

## 6. Agent Core 架构

保留现有成熟内核（有界循环、原生 tool_calls、JSON 工具回退、重复提醒、上下文压缩/裁剪分离、scope 动作掩码、错误边界），迁到服务端并接入 task-runtime：
- **Planner**：Goal 规范化 → 生成 Step DAG（每 Step 带验收条件）。简单任务退化为单 Step（不强制复杂规划）。
- **Executor**：现 `runChat` 循环改造为 `executeStep`，工具经 Capability Adapter 分派，结果写执行记录。
- **Evaluator**：独立模块，执行 Agent 不得自判成功（见 EVALUATION_SPEC）。

## 7. Capability Adapter

每工具绑定一个 CapabilityProvider，声明 `runtime ∈ {cloud, local-companion, dev}`、`permissions`、`healthCheck`。Executor 只调用 Environment Manifest 中"可用且健康"的能力；缺失则找替代/调整计划/请求补充/明确报告不可用（禁止假装具备）。详见 CAPABILITY_SYSTEM_SPEC。

## 8. Local Companion

`dev/llm-proxy.mjs` 演进为 opt-in 桌面伴侣：用户本机运行，持有 QQ/微信/terminal/fs 能力，经**出站**认证长连接（WebSocket/gRPC）向 Backend 注册能力并接收"本机工具调用"请求。云端 Agent 默认 Environment Manifest **不含**任何本机能力；仅当用户安装并授权 Companion 后，其能力才进入该用户 Manifest。开发态 `dev` runtime 等价于"开发者本机 Companion"，与生产云端严格区分。

## 9. 数据流（一次长任务）

```
SPA POST /goals → api 验 JWT → 写 agent_tasks(queued)+agent_events(goal.created) → 返回 taskId
Worker claim(lease) → Planner 生成 agent_steps(DAG) → checkpoint
  loop: Executor → llm(服务端密钥) → tool_calls → Capability Adapter
        → cloud 工具直接执行 / local 工具经 Companion 往返
        → 写 agent_tool_invocations(幂等) + agent_events + 业务副作用
        → 每阶段 checkpoint；heartbeat 续 lease
Evaluator 校验验收+证据 → succeeded / needs_input / failed
SPA GET /tasks/:id/events(SSE) 实时展示；崩溃后 resume 从 checkpoint 续跑
```

## 10. 安全边界

1. **密钥**：LLM key、Supabase service_role 仅存在于 Backend/Worker 服务端环境，绝不进 SPA bundle（现状已遵守：`config.ts` 浏览器恒 Mock，`llm-proxy.mjs` 密钥服务端）。
2. **用户隔离**：所有 agent_* 表 RLS `auth.uid()=user_id`；Worker 用 service_role 但**每次写入显式带 task.user_id**，并在代码层断言 `task.user_id === 请求 uid`（防跨用户）。
3. **本机能力**：terminal/fs/QQ/微信仅 Local Companion，云端默认不可见；高危操作服务端权限系统强制人工审批（非仅 Prompt）。
4. **SSRF**：web_fetch 服务端复检 + DNS 解析后私网拦截 + 禁重定向到私网 + 字节/超时上限（现状 `urlGuard.ts` 仅查初始 hostname，`/api/web/fetch` 不复检，需重构）。
5. **Prompt Injection**：工具/网页内容仅为数据；scope 硬锁定 + 动作掩码保留；Evaluator 独立校验证据来源。
6. **重放/重复副作用**：幂等键 + DB 唯一约束（现状幂等仅 localStorage `SEEN_KEY`，需服务端化）。

## 11. 部署架构

- 前端：Qoder Sites 静态托管（现状）。
- Backend API + Worker：单个小型 Node 主机（Fly.io/Render/一台 VPS），同镜像两 entrypoint；最低成本可同机。
- 数据/Auth/Storage：Supabase 托管 Postgres。
- LLM：DeepSeek（现状 `deepseek-flash`，服务端密钥）。
- 详见 DEPLOYMENT_SPEC（含最低成本方案与故障恢复）。

## 12. 保留 / 重构 / 废弃总览（逐项理由见各 SPEC）

保留：Native Tool Calling、Tool Registry、Scope Filtering、Tool Error Boundary、LLM Provider Adapter、Context Budget、Supabase Repository、URL Guard（增强）、Demo Repository、现有业务工具语义。
重构：runChat→服务端 agent-core；memory localStorage→服务端分层；幂等 localStorage→DB；verify_opportunity 自判 VERIFIED→Evaluator 裁决；web_fetch SSRF 加固；uid()→UUID。
废弃（云端）：run_terminal/read_file/write_file 直接云端暴露（移入 Local Companion，云端默认禁用）。