# 12 · 部署指南（Stage 8）

> 环境变量仅列名，不输出值。Modular Monolith + Durable Worker，无微服务/大消息队列。

## 部署拓扑

```
Qoder Sites（静态 SPA）──HTTPS+JWT──► Backend API（Node）──► Supabase Postgres/Auth/Storage
                                          │ 独立进程
                                          ▼
                                     Worker（Node）──► LLM Provider（DeepSeek）
                                          ▲ WSS
                          opt-in 用户 ──出站── Local Companion（桌面）
```

## 启动命令

| 角色 | 命令 | 说明 |
|---|---|---|
| 一体化开发 | `cd backend && npm start` | API+Worker 同进程，InMemory/Postgres |
| API 独立 | `npm run api` | 仅 HTTP API + Companion WSS |
| Worker 独立 | `npm run worker` | 仅任务执行 |
| 前端 | `cd web && npm run dev` / `npm run build` | Qoder Sites 静态托管 |

## 环境变量（名称）

| 变量 | 用途 |
|---|---|
| LLM_API_KEY / LLM_BASE_URL / LLM_MODEL | 服务端 LLM |
| SUPABASE_JWT_SECRET | 验 SPA JWT |
| SUPABASE_URL / SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD | Supabase 连接 |
| DATABASE_URL | Postgres 直连（生产必需） |
| PORT / WORKER_CONCURRENCY / LEASE_TTL_MS / HEARTBEAT_MS | 服务/Worker |
| COMPANION_TOKENS | Companion 设备授权 JSON |
| VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_BACKEND_URL | 前端公开 |

## 生产守卫

`NODE_ENV=production` 无 DATABASE_URL → 进程明确失败（ProductionDbRequiredError），**绝不静默降级 InMemory**（已验证）。

## 任务队列

Postgres `agent_tasks` + `FOR UPDATE SKIP LOCKED` + lease_expires_at；claim→running+lease；heartbeat 续 lease；过期重认领 attempt+1。无 Redis/Kafka。

## 健康检查 / 日志 / 监控

- `GET /v1/health` → {ok, store}（已验证）。
- Worker heartbeat 写 agent_tasks.heartbeat_at。
- 事件日志 agent_events（task→step→invocation→event 关联）；MetricsCollector（成功率/工具失败/evaluator 拒绝/token/cost/duration/queue/lease）。
- 独立监控告警系统：未实现（后续）。

## 最低成本方案

1 台小 VPS/Fly 共享 CPU（~$5/月）跑 api+worker 两进程；Supabase 托管 Postgres/Auth/Storage；Qoder Sites 前端；DeepSeek 按量；Companion 用户本机零服务器成本。

## Release Gate

生产部署人工批准（release.yml）；不自动应用未审核 migration；CI（ci.yml）web+backend 全过方可合并。

## 阻塞项（BLOCKED_EXTERNAL）

- 后端未实际部署生产主机（代码就绪）。
- migration 0002/0003 未应用生产（网络封锁，dashboard 应用）。
- 真实高校账号/Companion 授权需用户本人。