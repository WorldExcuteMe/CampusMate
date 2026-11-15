# 14 · 已知限制（Stage 8）

> 诚实记录未实现/未验证项，不虚报。

## NOT_IMPLEMENTED（未实现）

1. 记忆持久化表：Session/Episodic/Procedural 仅 InMemory，migration 未含 memory 表（Task State 在 agent_tasks 已持久化）。
2. 独立监控告警系统：MetricsCollector 就绪，无外部指标/告警导出。
3. 工作流前端入口页面：Onboarding 向导/Inbox 转换/周计划确认 UI（后端 API 就绪）。
4. Agent Workspace 完整 Plan/Step/Evidence/Approval 展示（已接 Task API/SSE）。
5. PDF 二进制→text / OCR：声明式文本提取就绪，二进制解析需 pdfjs/Companion。
6. write_file/run_terminal 内容哈希幂等（靠审批+授权约束）。

## BLOCKED_EXTERNAL（需真实环境/授权）

1. migration 0002/0003 应用生产 Supabase（直连/pooler/MCP 网络封锁；DDL 已 PGlite 验证）。
2. 真实 Supabase RLS 跨用户实测。
3. 真实进程 kill 崩溃恢复 E2E（当前模拟 lease 过期）。
4. 多 Worker 并发认领实测（SKIP LOCKED 经 PGlite 单连接验证）。
5. Companion 真实跨主机/NAT 部署。
6. 三开发者真实高校 dogfooding（AC19）+ 真实课表样本。
7. 后端实际部署生产主机（AC02 真实"关闭浏览器继续"）。

## PARTIAL（部分实现）

1. RecoveryEngine/Planner/Monitoring 模块就绪并单测，Worker 主循环完整接入为后续增量。
2. Evaluator 默认 acceptance 业务任务非空生成已实现，Worker 默认任务仍基线门控。
3. Calendar/Today 真实数据接线 + build 通过，真实课表需 migration+导入。
4. costUsd 硬停已实现；预算超限 request_decision 策略未实现（当前部分交付）。

## 非确定性回归

- dedupe.test.ts 全量并发首跑偶发状态污染（共享 demo 状态），隔离与重跑均通过。建议后续隔离 demo 状态。

## 设计约束（遵守）

- Phase 9（Multi-Agent/Dreaming/Skill Learning）延期。
- 不删除现有功能；不推翻已验证 Agent Core；不引入微服务/大消息队列。
- 不绕过高校认证/验证码/MFA；不向 LLM 提供密码；模型任意代码不作生产 Connector。
- 三开发者结果不宣称全国高校泛化。