# 03 · 可靠性报告（Stage 2）

> 基于真实代码 + 实跑测试。分支 feat/personal-campus-agent。

## 交付（A3–A9 核心）

| 项 | 实现 | 测试 | 状态 |
|---|---|---|---|
| A7 Budget 四维硬停（含 costUsd） | core/budget.ts checkBudget；agent-loop overBudget 接入 | reliability.test.ts、reliability-fault.test.ts（costUsd=0 立即硬停、tokens 硬停强制总结） | **VERIFIED** |
| A5 RecoveryEngine 差异化恢复 | core/recovery.ts（8 ErrorClass→策略，maxRetries/maxReplans/maxReexecutes 上限，禁止无限 replan） | reliability.test.ts（差异化/上限/退避） | **VERIFIED**（模块）；Worker 循环接入 PARTIAL |
| A9 Monitoring | core/monitoring.ts MetricsCollector（成功率/工具失败/evaluator 拒绝/token/cost/duration/queue/lease；task→step→invocation→event 关联） | reliability.test.ts | **VERIFIED**（模块）；Worker 埋点 PARTIAL |
| A3 Planner/DAG | core/planner.ts（Goal→Step DAG，dependsOn，非空验收，冻结/Revision，拓扑校验，Runtime 状态转换，并发1） | planner.test.ts（DAG/环检测/冻结/就绪门控/非法转换） | **VERIFIED**（模块）；Worker 调度接入 PARTIAL |
| A4 Evaluator 非空验收 | planner.defaultAcceptance（info/opportunity/plan 非空）；空验收不得文本即完成 | planner.test.ts | **VERIFIED**（生成）；业务任务默认注入 PARTIAL |
| A6 Per-tool Timeout | worker.withTimeout（TOOL_SPECS.timeoutMs 强制，超时→tool_transient 观测） | reliability-fault.test.ts | **VERIFIED** |

## 测试证据

- 后端 **132 测试，131 过，1 skip，0 失败**；tsc exit 0。
- 新增：reliability.test.ts（8）、planner.test.ts（6）、reliability-fault.test.ts（3）。
- AC07 Cost/Token/Time 预算硬停：**VERIFIED**（costUsd=0 立即停、tokens 硬停强制总结）。
- AC08 RecoveryEngine 差异化恢复：**VERIFIED**（错误注入 8 类策略 + 上限）。

## 设计要点

- RecoveryEngine 禁止无限：retry/backoff/repair 共用 maxRetries；alternate/replan 共用 maxReplans；evaluation reexecute 独立 maxReexecutes；超限升级 stop/pause。
- Planner 状态由 Runtime 转换（transitionStep 校验），模型不得直接改 DB Step 状态。
- 业务任务默认非空验收：info/opportunity 强制 source_cited + evidence_verified；plan 强制 artifact + no_expired。
- Budget 停止形成部分结果 + 剩余预算说明（budgetStopSummary）。

## 未接入 / 后续（PARTIAL）

- RecoveryEngine/Planner/Monitoring 已实现并单测，但 Worker 主循环尚未完整接入（当前 Worker 仍单循环 + 默认 Evaluator）。接入为 Stage 2 后续增量：Worker 用 Planner 生成 DAG 调度、RecoveryEngine 驱动错误恢复、MetricsCollector 埋点。
- 真实进程 kill 恢复 / 多 Worker 并发 / 真实 RLS：BLOCKED_EXTERNAL（生产库网络封锁）。
- write_file/run_terminal 内容哈希/状态核对幂等：A6 后续（当前靠审批+授权约束）。