# 07 · Checkpoint / Recovery 审查

## 重点检查 3：Checkpoint 是否支持真实进程崩溃恢复

**结论：Partial。检查点写入/恢复逻辑完整且测试通过；真实进程 kill 后恢复 Not Verified。**

### 已实现
- `store.writeCheckpoint`：每轮工具后 hooks.onCheckpoint 写 messages/stepProgress/repeat/usage（agent_checkpoints）。
- `store.latestCheckpoint` + Worker.executeTask：resume 从最新检查点还原 resumeMessages，过滤 `__approval_pending__` 哨兵。
- 崩溃重认领：lease 过期 → claimNext 重认领 attempt+1（worker.test.ts"崩溃重认领：lease 过期后另一 Worker 接管执行"通过）。
- 幂等保护：重认领后已提交副作用经 idempotencyKey 跳过（worker.test.ts 幂等测试）。

### 证据
- store.test.ts：checkpoint 写入+最新读取。
- worker.test.ts：崩溃重认领（模拟 now 超过 lease.expiresAt）。
- worker-approval.test.ts：resume 后重发工具调用、批准/拒绝路径。
- PGlite：checkpoint 写入/读取真实引擎验证。

### 未验证（Not Verified）
- **真实进程 kill**：现有"崩溃"测试用 `now` 参数模拟 lease 过期，未真实 `kill -9` Worker 进程后重启验证状态一致与无重复副作用。
- 审计建议：补 E2E——启动 Worker 进程→执行中途 kill→重启→断言从 checkpoint 续跑、副作用 exactly-once。

## 重点检查 10：Recovery Engine 是否覆盖不同错误类型

**结论：Partial。错误分类存在；分类驱动的差异化恢复策略未完全实现。**

### 已实现
- `core/errors.ts classifyError`：transport/rate_limit/invalid_model_output/tool_transient/tool_permanent/permission/budget/evaluation。
- `isRetryable`：transport/rate_limit/tool_transient 可重试。
- LLM 传输退避重试（llm.ts，429/5xx）。
- agent-loop catch：transport vs 其他分类，可读降级。
- 预算硬停 + 审批暂停 + 协作取消。

### 缺口
- 无独立 RecoveryEngine 模块按 ErrorClass 路由到 retry/fallback/replan/pause/escalate 的完整状态机。当前重试主要在 transport 层；tool_permanent→换源/replan 未实现 → **Partial**。