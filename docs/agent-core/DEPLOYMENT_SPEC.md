# DEPLOYMENT_SPEC · 生产部署 / 最低成本方案

> 提案规范，未实现。现状取证：前端 Qoder Sites 静态 SPA（`.CampusMate.qoder.site`）；`dev/serve.mjs` 仅开发态拉起本机 llm-proxy；生产 `/api/*` 无后端（functions/handler.ts 是 Hello 桩）；`VITE_LLM_EDGE_URL` 未定义。
> 目标：Backend API + Worker 真实生产部署；Qoder Sites 继续做前端托管。

## 1. 部署拓扑

```
Qoder Sites（静态 SPA）──HTTPS+JWT──► Backend API（Node）──► Supabase Postgres/Auth/Storage
                                          │ 同机/同镜像
                                          ▼
                                     Durable Worker（Node）──► LLM Provider（DeepSeek）
                                          ▲
                          opt-in 用户 ──出站WSS── Local Companion（桌面）
```

## 2. 各组件部署

### 2.1 前端（Qoder Sites）
- `npm run build` → 静态 dist → Qoder Sites 托管（现状流程）。
- 环境变量（公开）：`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`、`VITE_BACKEND_URL`（新增，指向 Backend API）。
- SPA 不再依赖 `/api/*` 本机代理；Agent 请求改打 `VITE_BACKEND_URL`。业务直读仍走 Supabase anon+RLS。

### 2.2 Backend API（Node）
- 模块化 Monolith，`backend/` 同仓库，entrypoint `api`。
- 部署：Fly.io / Render / 一台小 VPS（Docker 镜像）。无状态，可水平扩展。
- 职责：JWT 校验、任务提交/查询/取消/审批、SSE 进度、全局参考数据 service_role 写。
- 不在请求内跑 Agent Loop。

### 2.3 Worker（Node）
- 同镜像，entrypoint `worker`，`WORKER_CONCURRENCY=2`。
- 部署：与 API 同机（最低成本）或独立小实例。
- 职责：claim/heartbeat/execute/evaluate/finalize；lease/ checkpoint/ resume。
- 崩溃自愈：进程管理器（systemd/PM2/Fly restart）+ lease 过期重认领。

### 2.4 Supabase
- 托管 Postgres（业务 + agent_* 表）、Auth（邮箱密码，现状）、Storage（artifacts）。
- Migration 经 `supabase/migrations` 版本化（新增 agent_* 为独立 migration，待团队确认后应用）。
- service_role key 仅 Backend/Worker 环境变量。

### 2.5 Local Companion（opt-in）
- 桌面分发（现 llm-proxy.mjs 演进），用户本机运行，出站 WSS 连 Backend。
- 仅授权用户的能力进入其 Manifest；云端默认无本机能力。

## 3. 环境变量 / Secret

| 变量 | 位置 | 说明 |
|---|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | 前端（公开） | 现状 |
| `VITE_BACKEND_URL` | 前端（公开） | 新增，Backend API 地址 |
| `SUPABASE_URL` | Backend/Worker | 服务端 |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend/Worker（**机密**） | 绕过 RLS，仅服务端 |
| `SUPABASE_JWT_SECRET` | Backend/Worker（**机密**） | 验 SPA JWT |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | Backend/Worker（**机密**） | 现 .env.local，迁服务端 |
| `WORKER_CONCURRENCY` / `LEASE_TTL_MS` / `HEARTBEAT_MS` | Worker | 默认 2 / 60000 / 15000 |
| `COMPANION_WS_URL` | Backend | Companion 接入端点 |

机密绝不进前端 bundle（现状 config.ts 浏览器恒 Mock，遵守）。Secret 用平台 Secret 管理（Fly secrets/Render env），不入仓库。

## 4. Edge Function 限制（不当长 Worker）

Supabase Edge Functions（Deno）适合：认证辅助、极短请求（任务提交转发、状态读）。**不适合**长任务 Worker：有执行时长/资源上限、冷启动、无长连接 lease/heartbeat 语义。本架构 Worker 用独立 Node 进程。`functions/handler.ts` 现状 Hello 桩可演进为轻量提交转发（可选），但 Agent Loop 不在其中。`VITE_LLM_EDGE_URL` 回退（proxy.ts:99）保留为部署态短请求备用，非 Worker。

## 5. Health Check / 日志 / 监控

- Health：`GET /v1/health`（API 存活+DB 连通）；Worker 心跳写 `agent_tasks.heartbeat_at` + 独立 `worker_health` 表/日志。
- 日志：结构化 JSON（taskId/stepId/toolCallId/model/tokens/error），接 agent_events 持久化；平台日志聚合。
- 监控：任务队列深度、lease 过期率、工具失败率、Evaluator 拒绝率、token/成本/时延；阈值告警。
- 故障恢复：Worker 崩溃→lease 过期重认领；API 崩溃→无状态重启；DB 故障→Supabase 托管备份/PITR。

## 6. 最低成本方案（小规模产品）

```
1 台小 VPS / Fly 共享 CPU（~$5/月）：Docker 同镜像跑 api + worker 两进程（PM2/systemd）
Supabase Free/Pro（托管 Postgres+Auth+Storage）
Qoder Sites（前端托管，现状）
DeepSeek 按量（deepseek-flash，服务端密钥）
Companion：用户本机，零服务器成本
```
单 Worker 限并发 2 + Postgres 轻量队列足够小规模。无需 Redis/Kafka/多微服务。扩容路径：Worker 独立实例→多 Worker 共享 Postgres 队列（SKIP LOCKED 天然支持）→必要时再拆服务。

## 7. 上线检查清单

1. agent_* migration 经团队确认应用（本阶段未应用）。
2. service_role/JWT_SECRET/LLM_API_KEY 配置到平台 Secret。
3. 前端 `VITE_BACKEND_URL` 指向生产 API；CORS 允许 Sites 域名。
4. RLS 验证：跨用户访问 403（T27）。
5. Worker lease/heartbeat/崩溃恢复验证（T16/T17）。
6. SSRF/审批/幂等硬指标 100%（T23/T25/T26）。
7. 健康检查/日志/告警就绪。