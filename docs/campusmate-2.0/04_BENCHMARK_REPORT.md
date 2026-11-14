# 04 · Benchmark 报告（Stage 3）

> 真实运行证据。`node backend/scripts/run-benchmark.ts` → **BENCHMARK_PASS**。
> 确定性验证为主（关键字段/工具调用/证据/降级标记），非 LLM-as-judge。

## 1. 基准框架

- 目录：`backend/tests/agent-benchmark/`（types/cases/runner/dogfooding/benchmark.test）。
- 30 个标准化任务，7 类全覆盖；每例含 ID/UserGoal/Environment/InitialContext/AvailableCapabilities/ExpectedOutputs/AcceptanceCriteria/ExpectedEvidence/FailureConditions/EvaluationMethod。
- Runner 驱动**真实 runAgentLoop**（scripted transport + mock tools），确定性检查；manual_realworld 标 BLOCKED_EXTERNAL。

## 2. 运行结果（实跑）

```
总任务: 30 | VERIFIED: 30 | FAILED: 0 | BLOCKED_EXTERNAL: 0
End-to-End 成功率: 100.0%
证据覆盖: 100.0% | 恢复成功: 100.0% | 环境泛化: 100.0%
人工介入率: 0.0% | 平均成本: $0.000017 | 平均时延: <1ms
分类：planning 5/5 · long_horizon 4/4 · environment 4/4 · tool_reliability 5/5 · recovery 4/4 · evidence 4/4 · personalization 4/4
```

| 类别 | 任务 | 考察 |
|---|---|---|
| Planning | P01–P05 | 工具序列/依赖/多工具协同/直接回答 |
| Long-Horizon | L01–L04 | 多轮持续/预算内推进/预算硬停/重复不无限 |
| Environment | E01–E04 | 陌生网站/未知格式如实说明/能力缺失请求补充/跨源适配 |
| Tool Reliability | T01–T05 | 失败不中断/参数/幻觉拦截/JSON 回退/错误可读 |
| Recovery | R01–R04 | 传输失败降级/临时故障重试/审批暂停/取消 |
| Evidence | V01–V04 | VERIFIED 降级/无证据不声称完成/来源引用/冲突识别 |
| Personalization | U01–U04 | 专业筛选/时间冲突/年级资格/目标关联 |

## 3. 指标（B2）

End-to-End Success Rate、Evidence Coverage、Recovery Success Rate、Environment Generalization Rate、Human Intervention Rate、Avg Cost、Avg Duration 均由 `computeMetrics` 确定性聚合。关键业务字段（工具调用、降级标记、证据降级、冲突）用确定性断言，不用 LLM-judge。

## 4. Dogfooding（B3）

- `dogfooding.ts`：DogfoodingRecord（TaskID/Developer/Institution/Environment/DataSource/Format/AcquisitionMethod/AgentPlan/ExecutionTrace/HumanIntervention/FailureReason/FinalResult/Accuracy/ReusableAdaptation）+ FailureLibrary（open→fixed→regression_added）。
- 核心挑战（三开发者相同）：「获取个人课表，识别学期时间安排，并结合校园通知、竞赛和个人目标生成未来七天行动计划。」
- **三开发者真实测试材料待提供**（BLOCKED_EXTERNAL）：各自学校环境、信息来源、数据格式、获取方式、执行轨迹、人工介入、失败原因、准确率、可复用适配。
- 成功适配 → 回归测试（markRegression）；不得将三人结果宣称为全国高校泛化。

## 5. 测试与命令

- `node --test --test-force-exit`：**139 测试，138 过，1 skip，0 失败**（含 benchmark.test.ts 7 用例）。
- `node scripts/run-benchmark.ts`：BENCHMARK_PASS（30/30）。
- tsc exit 0。

## 6. 诚实边界

- 当前 30 任务为 **deterministic/integration**（scripted transport + mock tools），验证 Runtime 行为契约；**非真实高校端到端**。
- 真实高校泛化需三开发者 dogfooding + 脱敏公开数据 + 未知格式样本独立测试（BLOCKED_EXTERNAL）。
- AC18 Benchmark≥30：**VERIFIED**（30 任务运行通过）。AC19 三开发者真实测试：**BLOCKED_EXTERNAL**（机制就绪，材料待提供）。