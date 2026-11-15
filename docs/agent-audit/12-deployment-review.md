# 12 · 部署审查

> 环境变量仅列名称，不输出值。

## 当前生产部署拓扑（实际状态）

```
Qoder Sites（静态 SPA）── 现状唯一生产部署
  └─ 前端仍浏览器内 runChat（未接后端）
Backend（backend/）── 代码就绪，⚠ 未实际部署到生产主机
  └─ main.ts 一体化（API + Worker 同进程）
Supabase ── Postgres + Auth（0001 已应用；0002 ⚠ 未应用）
Companion ── 用户本机出站 WSS（⚠ 真实部署未验证）
LLM ── DeepSeek（服务端密钥，冒烟验证可达）
```

**诚实结论**：当前唯一实际生产部署是 Qoder Sites 静态前端。后端/Worker/Companion 代码与测试就绪，但**未部署到生产主机**，前端未切换调用。部署能力标 **Not Verified**（生产）。

## Backend API 部署方式

- 入口 `backend/src/main.ts`：`node src/main.ts`（Node ≥24 直跑 .ts）。
- HTTP：`api/server.ts`（node:http，零框架），端口 `PORT`（默认 8788）。
- 设计目标：Fly/Render/VPS Docker（DEPLOYMENT_SPEC），**未实际执行**。
- API/Worker 当前同进程；独立进程拆分未验证。

## Worker 部署方式

- 同 main.ts 进程内 `Worker.run`（pollMs 轮询 claim）。
- 并发 `WORKER_CONCURRENCY`（默认 2）；lease `LEASE_TTL_MS`/`HEARTBEAT_MS`。
- 独立 Worker 进程入口未单独提供（main.ts 一体化）。

## Supabase 配置结构

- 业务表（0001）+ agent_*（0002，未应用）。
- Auth：邮箱密码，auth.uid() RLS。
- 连接：`DATABASE_URL` 或 `SUPABASE_DB_PASSWORD`+`SUPABASE_PROJECT_REF`（connectionStringFromEnv）。
- service_role 仅服务端（代码层 user_id 隔离）。

## 环境变量名称（不含值）

| 变量 | 用途 |
|---|---|
| LLM_API_KEY / LLM_BASE_URL / LLM_MODEL | 服务端 LLM |
| SUPABASE_JWT_SECRET | 验 SPA JWT |
| SUPABASE_URL / SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD | Supabase 连接 |
| DATABASE_URL | Postgres 直连（优先） |
| PORT / WORKER_CONCURRENCY / LEASE_TTL_MS / HEARTBEAT_MS | 服务/Worker |
| COMPANION_TOKENS | Companion 设备授权（JSON） |
| VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_BACKEND_URL | 前端公开 |

## 任务队列运行机制

- Postgres 轻量队列：`agent_tasks` + `FOR UPDATE SKIP LOCKED` + lease_expires_at。
- claim→running+lease；heartbeat 续 lease；过期重认领 attempt+1。
- 无 Redis/Kafka。InMemory 模式用于开发/测试。

## 日志和监控

- 事件日志：agent_events（append-only，结构化 payload）。
- 控制台日志：main.ts [api]/[worker] 启动行。
- **无独立监控/告警系统**（DEPLOYMENT_SPEC 设计有，未实现）→ Not Implemented。

## 生产环境健康检查

- `GET /v1/health` → {ok, store}（api.test.ts 验证）。
- Worker 心跳写 agent_tasks.heartbeat_at。
- 生产主机健康探针未部署 → Not Verified。