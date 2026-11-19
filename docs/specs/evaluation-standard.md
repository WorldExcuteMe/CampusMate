# 外部基准评测标准 v2：思考模式与推理档位（2026-11-19）

## 为什么升版

此前所有外部基准（AppWorld / OfficeBench / Terminal-Bench / GDPval / HORIZON）使用
`LLM_CAPABILITIES.reasoning = "none"`：**不发送任何思考控制参数**，端点按默认非思考模式作答
（实测 103/103 请求 `reasoning_tokens = 0`）。而公开横向对照（Apache Maka 的 Terminal-Bench 2.1 九臂研究）
使用 DeepSeek V4 Flash 的 **max 推理**。两者不可直接比较，且非思考模式会低估模型在规划/编程/长程任务上的能力。

产品侧自本版起支持显式推理档位：能力声明 `reasoning:"reasoning_effort"` + 偏好 `minimal|low|medium|high|xhigh|max`，
按端点枚举原样发送（实测端到端 `effective="max"`、`reasoning_tokens>0`、供应商请求 ID 与 USD 成本均可记录）。

## 标准配置（后续所有正式评测默认使用）

| 项 | 标准值 | 说明 |
| --- | --- | --- |
| 模型 | `self-dploy/DeepSeek-V4-Flash` | AMD Radeon Cloud |
| 能力声明 | `{"tools":"native","vision":false,"streaming":false,"temperature":true,"reasoning":"reasoning_effort","outputParameter":"max_tokens","maxOutputTokens":32768}` | 输出预算 32768，容纳推理 token |
| 推理偏好 | **`max`**，按**任务**锁定，不在任务内切换 | 切换档位会改变端点注入的思考前缀，导致整段 KV 缓存失效 |
| 单请求超时 | 240s（原 180s） | max 推理解码更长，需留余量 |
| 上下文上限 | 262144 | 与端点配置一致 |
| 并发 | 对照臂 1；吞吐臂 2（账本注明，不与对照臂混用） | 端点时延波动是已知混杂因素 |

注意：产品在输出预算 <1024 时会自动把高档位降为 medium（避免推理把输出截断）；正式评测的
`maxOutputTokens` 必须 ≥32768，否则 `effective` 会被降档。

## 各基准预算（标准臂）

| 基准 | 墙钟/题 | token/题 | 工具/题 | 轮次 | 备注 |
| --- | --- | --- | --- | --- | --- |
| AppWorld | 1200s | 1,000,000 | 120 | 60 | 依据 R7：参考解需大量读写调用，600k/80/40 对 hard 题不足 |
| OfficeBench | 600s | 400,000 | 60 | 默认 60 | 官方评分器与题面不变；环境说明仍要求产物在 `data/` |
| Terminal-Bench 2.1 | 官方 450s agent 预算 | 官方/驱动默认 400k | 60 | 官方 20 轮 | 逐题 Harbor 作业；并发 1 为标准臂 |
| GDPval | 600s | 默认 | 默认 | 默认 | 研究→文档导出全链路 |
| HORIZON-001 | 1200s/轮次组 | 默认 | ≤12 | 10+ | 长程与断点恢复 |

## 记录要求

每轮运行必须在账本记录：`arm`（`standard-max` / `baseline-none`）、模型 ID、capabilities、推理档位、
`maxOutputTokens`、超时、预算、并发、端点时延背景、逐题 reward/检查项、token（含 reasoning）、缓存命中、
成本。**不同 arm 的结果分开列，不得混算通过率。** 端点时延波动大时，对照轮次应相邻时段交替执行。

## 启动方式

- AppWorld 单变量实验：`experiments/run-experiment.ps1`（默认已是标准配置：reasoning_effort+max、32768、240s；
  预算用 `-ToolBudget/-TokenBudget/-MaxRounds/-TimeoutMs` 覆盖）。
- Terminal-Bench：`start-terminal-batch.ps1`（已设置为标准臂：max、32768、240s；驱动默认 400k/60/600s，
  可用 `CM_BUDGET_*` 覆盖）。
- 产品实际入口：任务请求携带 `reasoning: "max"`（任务级偏好，同任务内固定）。
- 探针：`experiments/probe-standard-reasoning.mjs` 验证端到端档位与 usage（成本 <$0.0001）。

## 与历史结果的关系

2026-11-18 夜至 11-19 上午的所有结果均为 **baseline-none arm（非思考）**，保留为基线，不重算；
标准臂（standard-max）将作为后续正式评测的主口径，重跑关键基准时单独出表。
