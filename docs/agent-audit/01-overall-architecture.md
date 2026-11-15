# 01 · 总体架构（基于真实代码）

> 所有图以 `backend/src` 实际代码为依据。标注 ⚠ 处为未接通/未验证环节。

## 1. Overall Architecture

```
┌─ 用户浏览器 ─────────────────────────────┐
│ Qoder Sites 静态 SPA (React)             │
│  AgentChatPage.send() → runChat()  ⚠ 仍浏览器内循环（未接后端）
│  AuthProvider(Supabase Auth)             │
└──────────────────────────────────────────┘
        （后端为并行实现，前端尚未切换调用）
┌─ Backend（backend/，Node，零框架）──────────────────────────┐
│ api/server.ts  HTTP：/v1/tasks /events /cancel /resume       │
│                /v1/approvals /v1/capabilities /v1/health     │
│ api/jwt.ts     HS256 验 Supabase JWT                         │
│ companion-server.ts  WSS /companion（Companion 出站接入）    │
│ runtime/worker.ts  Durable Worker（claim/lease/execute/eval）│
│ core/agent-loop.ts 纯执行循环                                │
│ runtime/store.ts InMemoryStore │ postgres-store.ts PostgresStore │
└──────────────────────────────────────────────────────────────┘
        │ pg（DATABASE_URL 时）              │ WSS RPC
        ▼                                    ▼
┌─ Supabase Postgres ─────────┐   ┌─ Local Companion（用户本机）─┐
│ 业务表 + agent_*（migration │   │ companion-client.ts          │
│ 0002，⚠ 未应用生产）        │   │ terminal/fs/QQ/微信（授权）  │
└─────────────────────────────┘   └──────────────────────────────┘
```

## 2. Agent Runtime Architecture

```
core/agent-loop.ts runAgentLoop(opts)
  ├─ 组装 messages（system/history/user 或 resumeMessages）
  ├─ for i < maxRounds(20):
  │    ├─ overBudget()? → break（预算硬停）
  │    ├─ transport.chat(messages, tools)   [core/llm.ts DeepSeekTransport]
  │    ├─ toolCalls → executeTool（注入）→ tool 消息 → trimToBudget（原子压缩）
  │    ├─ <tool_result> 拦截 / parseJsonTool 回退
  │    └─ 无工具 → 返回 reply
  └─ catch → isTransportError 分类 → 可读降级（永不 [object Object]）
```

## 3. Task Lifecycle Diagram

```
queued ─claim→ running ─┬→ succeeded（Evaluator passed）
                        ├→ failed（Evaluator 拒绝/异常）
                        ├→ needs_input（审批暂停）─resume→ queued
                        ├→ paused ─resume→ queued
                        └→ cancelled（cancelRequested）
failed ─retry→ queued      lease 过期 → queued（重认领 attempt+1）
```
状态机：`runtime/state-machine.ts TASK_TRANSITIONS`（纯函数校验）。

## 4. Worker Execution Flow

```
runtime/worker.ts Worker.tick()
  claimNext(SKIP LOCKED/lease) → executeTask:
    ├─ cancelRequested? → cancelled
    ├─ latestCheckpoint → resumeMessages（清审批哨兵）
    ├─ buildManifest → manifestTools（能力门控）
    ├─ buildContext（taskContext 恒注入 + 记忆隔离检索）
    ├─ runAgentLoop（wrappedExecuteTool：幂等→Companion授权→审批→执行/RPC）
    ├─ paused? → needs_input
    ├─ evaluator(task,result) → certificate
    └─ passed? succeeded : failed（存证书）
  heartbeat：setInterval renewLease
```

## 5. Tool Execution Flow

```
wrappedExecuteTool(name,args):
  1 idempotencyKey → getInvocation 已成功? → 返回缓存（去重）
  2 checkHostAuthorization（本机工具需 Companion 授权范围）
  3 requiresApproval? → ApprovalStore：rejected→拒绝 / pending→needs_input哨兵 / approved→继续
  4 本机工具+companionServer → CompanionServer.invoke（WSS RPC）
    否则 → executeTool（云工具 cloud-tools.ts）
  5 recordInvocation（ON CONFLICT 幂等）→ 返回结果
```

## 6. Checkpoint / Recovery Flow

```
每轮工具后 → hooks.onCheckpoint → store.writeCheckpoint(messages/stepProgress/repeat/usage)
崩溃 → lease 过期 → claimNext 重认领（attempt+1）
resume → latestCheckpoint → resumeMessages（过滤 __approval_pending__）→ 续跑
幂等键 → 已提交副作用跳过
⚠ 真实进程 kill 恢复未验证（仅模拟 lease 过期）
```

## 7. Capability Registry

```
core/capability.ts CapabilityRegistry（register/resolve/healthCheck）
  registerCloudDefaults：llm.chat/web.fetch/web.search/rag.search/db.*
core/manifest.ts buildManifest：云端默认 + Companion 授权叠加
  resolveCapability：缺失→ALTERNATIVES 替代 / 明确报告不可用
core/tool-registry.ts manifestTools：按 Manifest 过滤模型可见工具
Worker 任务前调用 → 实际参与执行决策（已验证）
```

## 8. Memory / Context Architecture

```
core/memory.ts InMemoryMemoryStore（User/Session/Episodic/Procedural）⚠ 仅内存
core/context-builder.ts buildContext：stableInstructions/taskContext/userProfile/relevantMemory/toolSchemas
  taskContext 事实来源恒注入；retrieveRelevantMemory 按 user+task 隔离
core/context.ts groupTurns/trimToBudget：按轮次组原子压缩，validatePairing 无孤儿
```

## 9. Evaluator Architecture

```
core/evaluator.ts Evaluator.evaluate(taskId, criteria, input)
  evidence_verified → verifyEvidence：独立重抓 URL + excerpt 比对（防幻觉）
  其余 evaluateCriterion（artifact/field/count/no_expired/source_cited）
  全部 required 通过 → CompletionCertificate.passed=true
core/verification.ts：propose_verification 自填 VERIFIED 降级；canPersistVerified 门控
Worker 据 certificate 才 succeeded（独立于执行 Agent，已验证）
```

## 10. Deployment Architecture

```
Qoder Sites（静态 SPA，现状）
Backend API + Worker：backend/src/main.ts 一体化（同进程，InMemory 或 Postgres）
  ⚠ 未实际部署到生产主机；未拆独立进程
Supabase：Postgres + Auth（migration 0002 ⚠ 未应用）
Companion：用户本机出站 WSS（⚠ 真实跨主机未验证）
LLM：DeepSeek（服务端密钥，冒烟验证可达）
```