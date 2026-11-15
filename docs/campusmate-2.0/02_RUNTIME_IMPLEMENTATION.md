# 02 · Runtime 实现（Stage 1）

> 基于真实代码。前后端打通 + API/Worker 分离 + 生产 Postgres 守卫 + SSE。

## 1. 前端 → 后端 Task API（AC01）

```
AgentChatPage.send()
  ├─ backendEnabled()（VITE_BACKEND_URL 配置）?
  │    ├─ 是 → runTaskViaBackend({title,intent,sessionId})
  │    │        ├─ createTask → POST /v1/tasks（JWT）→ taskId
  │    │        └─ subscribeTask（SSE /v1/tasks/:id/stream?token=，失败回退轮询 /events）
  │    │             └─ 终态 → getTask → 展示 result.summary
  │    └─ 否 → runChat（浏览器 fallback，开发/兼容）
```
- 文件：`web/src/lib/agent/api-client.ts`、`web/src/features/agent/AgentChatPage.tsx`。
- JWT 取自 `supabaseClient.auth.getSession().access_token`，服务端 HS256 验证（`api/jwt.ts`）。
- user_id 隔离：server.ts 每端点校验 `task.userId === uid`，跨用户 403。

## 2. API / Worker 独立入口（A2）

| 入口 | 角色 | 命令 |
|---|---|---|
| `src/main-api.ts` | 仅 HTTP API + Companion WSS | `npm run api` |
| `src/main-worker.ts` | 仅 Worker（claim/lease/execute/eval/recovery） | `npm run worker` |
| `src/main.ts` | 一体化开发（API+Worker 同进程） | `npm start` |

共享装配 `src/app-context.ts buildContext`：
- `NODE_ENV=production` 且无 `DATABASE_URL` → 抛 `ProductionDbRequiredError`，进程 exit 1，**绝不静默降级 InMemory**。
- 有 `DATABASE_URL` → PostgresStore；开发无 DB → InMemoryStore。
- API 与 Worker 共享同一 Core/Contracts/Store 类型。

## 3. SSE 实时进度

`GET /v1/tasks/:id/stream?token=<JWT>`（EventSource 无法设 header，用 query token）：
- 每秒推送 `task_event`（增量事件，after seq）+ `task_status`（status/usage/result）。
- 终态（succeeded/failed/cancelled）推送 `close` 并结束流。
- 前端 `subscribeTask`：SSE 优先，`onerror` 回退轮询 `getTask`（1.5s）。

## 4. 任务生命周期（前端可用）

create → queued → Worker claim → running →（needs_input 审批 / succeeded / failed / cancelled）。
前端：cancelTask（POST /cancel）、resumeTask（POST /resume，needs_input/paused/failed → queued）。

## 5. 测试

- `backend/src/api/stage1-runtime.test.ts`：生产守卫抛错、开发 InMemory/Postgres 选择、SSE 推送终态、SSE 无 token 401。
- `web/src/lib/__tests__/api-client.test.ts`：backendEnabled、createTask 携带 JWT、getTask 解包、listEvents after、cancel/resume、错误可读透传、未配置抛错。

## 6. 未实现（后续 Stage）
- Planner/DAG（A3）、Evaluator 非空验收（A4）、RecoveryEngine（A5）、Tool Timeout/costUsd 硬停（A6/A7）、Monitoring（A9）。
- 真实部署 E2E（AC02/AC03/AC04）BLOCKED_EXTERNAL。