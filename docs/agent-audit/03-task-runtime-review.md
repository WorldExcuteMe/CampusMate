# 03 · Task Runtime 审查

## 重点检查 1：Task Runtime 是否真正独立于浏览器生命周期

**结论：Partial。后端独立成立，生产前端未接通。**

### 证据
- 后端 `backend/src/runtime/worker.ts` + `core/agent-loop.ts` 在 Node 进程执行，无浏览器全局（无 localStorage/window/fetch 浏览器依赖；fetch 为 Node 全局）。冒烟 `scripts/smoke.ts` 在纯 Node 进程跑通 task→succeeded，证明后端运行时不依赖浏览器。
- 任务状态持久化于 `agent_tasks`（PostgresStore）或 InMemoryStore，独立于聊天历史。
- **但** `web/src/features/agent/AgentChatPage.tsx:90` 仍 `await runChat(...)`（浏览器内循环）。前端未调用后端 `/v1/tasks`。生产用户关闭浏览器仍会停止其当前会话的浏览器循环。

### 判定
- 后端 Task Runtime 独立于浏览器：**Complete**（代码+冒烟证据）。
- 端到端"用户任务独立于浏览器"：**Partial / Not Implemented**（前端未切换）。

## 状态机与持久化

- `runtime/state-machine.ts`：TASK_TRANSITIONS 纯函数校验，非法转换抛错（runtime.test.ts 验证）。
- 状态：queued/running/needs_input/paused/succeeded/failed/cancelled；succeeded 仅 Evaluator passed。
- 事件 append-only（agent_events seq 单调），检查点独立表。
- 结构化状态=事实来源，事件=追踪，检查点=恢复，三者分表（PGlite 验证）。

## 缺口
- 前端集成（Not Implemented）。
- 生产库持久化（Not Verified，migration 未应用）。
- Goal/Step DAG 规划：types 与表已定义，Planner 自动生成 DAG 未实现（Worker 当前单循环，acceptance 默认空）→ **Partial**。