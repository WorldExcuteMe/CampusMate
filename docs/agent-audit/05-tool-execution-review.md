# 05 · Tool Execution 审查

## 重点检查 4：Tool Idempotency 是否覆盖所有有副作用工具

**结论：Partial。DB 写工具覆盖幂等；主机写工具按设计非幂等（需审批+授权约束）。**

### 幂等键覆盖（runtime/idempotency.ts）
| 工具 | 副作用 | 幂等键 | 覆盖 |
|---|---|---|---|
| save_to_inbox | db | inbox:userId:hash(title\|deadline\|source) | ✔ |
| extract_notice | db | 同 inbox | ✔ |
| create_opportunity | db(global) | opp:hash(title\|type\|deadline\|sourceUrl) | ✔ |
| create_daily_task | db | daily:userId:hash(title\|dueAt) | ✔ |
| set_growth_goal | db | goal:userId:norm(goal) | ✔ |
| merge_inbox | db | 默认 tool:hash(args) | ✔（默认键） |
| propose_verification | db | 默认 tool:hash(args) | ✔（默认键） |
| write_file | host | 默认键，但 TOOL_SPECS.idempotent=false | ⚠ 非幂等（重复写覆盖） |
| run_terminal | host | 默认键，idempotent=false | ⚠ 非幂等（命令可能非幂等） |
| web_fetch/web_search | network 只读 | 默认键 | 无副作用 |

### 机制
- `agent_tool_invocations unique(task_id, idempotency_key)` + `ON CONFLICT DO NOTHING`（PGlite 验证 deduped）。
- worker.wrappedExecuteTool：已成功 invocation 直接返回缓存，不重复副作用。
- 业务表第二道防线：inbox dedup_key 唯一索引、opportunities content_hash 唯一索引（PGlite 验证）。

### 判定
- DB 写工具幂等：**Complete**。
- 主机写工具（write_file/run_terminal）：**Partial**——按设计标非幂等，靠审批+授权范围约束，重复执行仍可能重复副作用。审计建议：主机写工具引入内容哈希/命令结果缓存或显式去重。

## 执行边界与安全
- 错误边界：executeTool 任何异常→可读 error 观测（永不 [object Object]）。
- SSRF：core/ssrf.ts safeFetch（DNS 解析后私网拦截+重定向逐跳+字节/超时），ssrf.test.ts(9) 验证。
- 审批：requiresApproval（terminal/fs/全局写/核验/群摄取），未批准→needs_input 不执行（worker-approval.test.ts 6 验证）。
- Companion 授权：checkFsPath/checkTerminal/checkGroup（companion.test.ts 5 验证）。

## 缺口
- 主机写工具幂等（Partial）。
- 工具 timeout/retry 元数据（TOOL_SPECS）已定义，但 Worker 未逐工具强制 timeout（仅 llm transport 与 safeFetch 有超时）→ **Partial**。