# 10 · Memory / Context 审查

## 重点检查 7：Memory 是否实现用户隔离

**结论：Complete（InMemory 层）；持久化 Not Implemented。**

### 隔离机制（core/memory.ts）
- UserMemory：per userId。
- SessionContext：key=`sessionId|userId`，跨用户 getSession→null。
- Episodic：listEpisodic(taskId,userId) 双键过滤，跨任务/跨用户不可见。
- Procedural：listProcedural(userId) 按用户；addProcedural 须 verifiedBy=evaluator。

### 证据
- context.test.ts："记忆隔离：会话跨用户不可见，Episodic 跨任务不可见"、"Procedural 须 evaluator 验证；按用户隔离"、"retrieveRelevantMemory 按 user+task 隔离检索" 通过。

### 缺口
- **仅 InMemoryMemoryStore**：migration 0002 不含 memory 表；重启丢失，多进程不共享 → 持久化 **Not Implemented**。
- Task State 事实来源在 agent_tasks（已持久化），但 Session/Episodic/Procedural 未持久化。

## 重点检查 8：Context Compression 是否保护完整 Tool Call / Tool Result 交互

**结论：Complete。按轮次组原子压缩，配对完整性校验。**

### 机制（core/context.ts）
- `groupTurns`：assistant(tool_calls)+其后 tool 结果=一组。
- `trimToBudget`/`composeContext`：超阈值整组丢弃，绝不拆散配对。
- `validatePairing`：检测孤儿 tool（无匹配 tool_call_id）。
- 工具结果裁剪（spill）与历史压缩分离；最新 tool 保留完整。

### 证据
- context.test.ts(9)：groupTurns 分组、validatePairing 孤儿检测、超窗压缩配对完整、composeContext 按组保留、spill 较旧裁剪最新保留、taskContext 恒注入。
- agent-loop-context.test.ts(2)：多轮工具超窗循环收尾配对完整、resumeMessages 配对保留。

## 重点检查 9：Budget Controller 是否能够硬性限制预算

**结论：Complete（token/toolCalls/wallMs 硬停）。**

### 机制
- `agent-loop.ts overBudget`：usage.tokens≥budget.tokens || toolCalls≥budget.toolCalls || wallMs≥budget.wallMs → break + 强制总结。
- budget 来自 task.budget（DEFAULT_BUDGET tokens200000/toolCalls40/wallMs600000/costUsd0.5）。
- costUsd 按 pricePerToken 估算累加。

### 证据
- agent-loop.test.ts"预算硬停：toolCalls=1→强制总结，budgetExceeded=true"通过。

### 缺口
- costUsd 硬停未单独触发测试（仅累加）；budget.costUsd 阈值未纳入 overBudget 判定 → **Partial**（cost 维度未硬停）。
- 预算超限"部分交付/请求决策"策略：当前强制总结（部分交付），request_decision 未实现。