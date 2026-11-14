# 13 · 已知问题（审计重点）

> 按影响排序。每项含证据与建议。Status 与 02 对照表一致。

## P0 · 前端未接后端（Partial / Not Implemented）
- 证据：`web/src/features/agent/AgentChatPage.tsx:90` 仍 `runChat`（浏览器循环）。
- 影响：生产用户任务仍依赖浏览器生命周期；后端 Task Runtime/Worker/持久化未对生产用户生效。
- 建议：前端 send() 改调 `POST /v1/tasks` + 轮询/SSE `/v1/tasks/:id/events`；保留浏览器路径为 fallback。

## P0 · Migration 0002 未应用生产（Not Verified）
- 证据：直连 ECONNRESET / pooler 区域不匹配 / MCP 未完成；DDL 已 PGlite 验证 16/16。
- 影响：生产无 agent_* 表，PostgresStore 无法启用；生产库 RLS/集成未验证。
- 建议：Dashboard SQL Editor 应用 0002；设 DATABASE_URL 启用 PostgresStore；跑 postgres-integration.test.ts。

## P1 · 真实进程崩溃恢复未验证（Not Verified）
- 证据：崩溃测试用 now 模拟 lease 过期，未真实 kill 进程。
- 影响：durable execution 核心承诺缺真实证据。
- 建议：E2E kill -9 Worker→重启→断言 checkpoint 续跑 + 副作用 exactly-once。

## P1 · 记忆未持久化（Not Implemented）
- 证据：仅 InMemoryMemoryStore；0002 无 memory 表。
- 影响：重启丢失 Session/Episodic/Procedural；多进程不共享。
- 建议：增 agent_sessions/agent_messages/agent_skills 表 + PostgresMemoryStore（需新 migration，本轮不改库）。

## P1 · 主机写工具非幂等（Partial）
- 证据：TOOL_SPECS write_file/run_terminal idempotent=false。
- 影响：重复执行可能重复副作用（靠审批+授权约束）。
- 建议：内容哈希/命令结果缓存去重。

## P2 · cost 预算未硬停（Partial）
- 证据：overBudget 仅 tokens/toolCalls/wallMs；costUsd 累加但未判定。
- 建议：纳入 costUsd≥budget.costUsd 硬停。

## P2 · Recovery Engine 不完整（Partial）
- 证据：classifyError 存在，但无按 ErrorClass 路由 retry/fallback/replan/escalate 的独立模块。
- 建议：独立 RecoveryEngine，tool_permanent→换源/replan。

## P2 · Planner/DAG 未实现（Partial）
- 证据：agent_steps 表/类型就绪，Worker 当前单循环，defaultAcceptance 空。
- 影响：多步依赖任务/验收条件需调用方注入。
- 建议：Planner 生成 Step DAG + 业务验收条件。

## P2 · Companion 真实跨主机未验证（Not Verified）
- 证据：WSS 测试进程内；真实 NAT/跨主机未测。
- 建议：真实设备出站连接 E2E。

## P3 · 监控/告警未实现（Not Implemented）
- 证据：仅事件日志+控制台；无独立监控。
- 建议：队列深度/lease 过期率/工具失败率/Evaluator 拒绝率指标+告警。

## P3 · 前端旧 uid() 非 UUID（Partial）
- 证据：web/src/lib/data/types.ts uid()=Math.random；后端已用 randomUUID。
- 影响：前端旧 Supabase 写路径潜在缺陷（前端未接后端，暂不影响后端）。

## 审计声明
- 本轮未补造任何测试结果；所有 Not Verified 均因缺真实环境（网络封锁/未部署/未 kill）。
- 未删除任何代码；未改 DB 结构；未大规模重构。
- Phase 9（Multi-Agent/Dreaming/Skill Learning）延期，不在本轮。