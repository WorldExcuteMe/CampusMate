# 01 · 目标架构（CampusMate 2.0）

> 基于真实代码。Modular Monolith + Durable Worker + Capability Adapter。

## 总体

```
Qoder Sites SPA ──JWT──► Backend API ──► Supabase Postgres/Auth/Storage
   │                      │ 独立进程
   │                      ▼
   │                   Worker（claim/lease/execute/eval/recovery）──► DeepSeek
   │                      ▲ WSS
   └─ opt-in ──► Local Companion（terminal/fs/QQ/微信，授权）
```

## 模块（backend/src）

- core：agent-loop（纯循环）/llm（DeepSeek）/errors/budget/recovery/monitoring/planner（DAG）/evaluator（独立证据）/evidence/verification/capability/manifest/tool-registry/context（压缩配对）/context-builder/memory（五类隔离）/personal-context/schedule-import/institution-adapter（声明式）/workflows（四链路）/companion（+server/client）/ssrf/cloud-tools。
- runtime：state-machine/store（InMemory）/postgres-store/sql（pg）/idempotency/approval/worker。
- api：jwt（HS256）/server（HTTP+SSE+工作流+课表+capabilities）。
- 入口：main（一体化）/main-api/main-worker；app-context（生产 Postgres 守卫）。

## 前端（web/src）

- domain：business-objects/calendar-grid/today。
- agent：api-client（Task API+SSE+课表）/AgentChatPage（默认后端）。
- features：calendar（周视图）/dashboard（Today）/inbox/radar/trust/growth/profile/settings。
- 导航：Today/智能体工作台/信息中心/校园日历/任务与目标/机会中心/可信核验/成长中心。

## 数据

- 业务（0001）：profiles/inbox/opportunities/tasks/goals/plans。
- Agent 运行时（0002）：agent_tasks/steps/events/checkpoints/tool_invocations/artifacts/evidence/goals。
- 个人上下文（0003）：user_institution_profiles/academic_terms/courses/course_schedules/schedule_exceptions/import_jobs。
- 结构化状态=事实来源；事件=追踪；检查点=恢复；三者分离。

## 关键原则

- 单 Agent Runtime（Phase 9 延期）；声明式适配器（无任意代码）；独立 Evaluator（执行 Agent 不自判）；副作用审批；user_id 隔离 + RLS；密钥仅服务端；生产不降级 InMemory。