# CampusMate Agent 架构 v2：全面优化蓝图（2026-11-19）

> 输入：本地 DSH 源码逐子系统分析、Codex/Gemini CLI/OpenHands/SWE-agent/Aider 对比
> （`docs/specs/agent-architecture-comparison.md` 与 `docs/specs/architecture-references/`）、
> 2025–2026 agent 范式调研（`agent-arch-refs/research-agent-paradigms.md`）、GitHub 成熟方案调研
> （`research-github-solutions.md`）、DSH 其余子系统深挖（`research-dsh-deep.md`）。
> 本文是"想全"后的总蓝图：先列全部维度与目标，再给分阶段重构计划与验收标准。

## 0. 北极星与设计原则

成熟 agent 系统的共同点：**可回放的状态、受控的工具界面、可验证的收敛、可观测的成本**。
CampusMate v2 的目标架构围绕四句话：

1. **事件是唯一事实来源**（append-only session log），消息是投影，检查点是快照；
2. **上下文是工程问题**：稳定前缀 + 分层预算 + 结构化压缩 + 外部记忆/计划文件 + 按需技能/工具；
3. **工具是契约**：显式 schema、结果信封、错误可纠正、按能力门控、可批处理、可代码化（PTC）；
4. **收敛可验证**：独立验收 + 修复闭环 + 失败轨迹可回放 + 变更由**回归闸门**把关。

四条硬约束：向后兼容（运行中的产品与测试）、可单变量验证（每个机制有开关与指标）、
成本可控（token 预算/effort 分级/缓存）、不过度工程（单产品 1.5 万行代码量级，拒绝 119-crate 式架构）。

## 1. 全维度 brainstorm（现状 → 成熟做法 → v2 目标 → 优先级）

图例：P0 立即、P1 本迭代、P2 下一迭代、P3 观察后再说。成本：S/M/L。收益：★★★ 高。

| # | 维度 | 我们的现状 | 成熟做法（例子） | v2 目标 | 成本/收益 | 阶段 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 会话状态 | transcript + JSON checkpoint，事件流只做观测 | DSH 事件日志+投影；Codex ResponseItem 事件流 | **事件权威**：log→deriveMessages；resume=重放；崩溃=追加修复事件 | M/★★★ | P0 已完成基础，P1 持久化 |
| 2 | 循环模型 | 单循环 + 多类守卫 | DSH turn/step + 两车道 inbox；Gemini Turn.run | turn/step 显式化；steering（用户插入/纠偏）在有界点生效 | L/★★ | P2 |
| 3 | 上下文预算 | 单一 cap + trim + 平铺摘要（已升级结构化摘要） | 两级压缩（遮蔽→摘要）、稳定前缀、动态尾部 | 分层预算（system/tool schema/history/tail）+ 稳定前缀 + JSON-safe spill + 结构化摘要 | M/★★★ | P1 |
| 4 | 计划/待办 | 本次新增 todo_write（无持久化） | TodoWrite、plan mode、计划文件 | 计划持久化进 checkpoint/事件；taskContext 注入当前计划；完成后沉淀"复盘"记忆 | S/★★★ | P1 |
| 5 | 工具协议/ACI | native+JSON、参数校验、结果裁剪（已 JSON-safe） | 双结果（模型/显示）、结果信封、空输出提示、窗口化编辑 | 统一结果信封（ok/error.class/next_hint/retrievable）+ 失败可操作化（已部分）+ 工具级输出 schema | M/★★★ | P1 |
| 6 | 工具规模/渐进披露 | 全部工具常驻 schema | Tool Search Tool / defer_loading（省 85% token）；MCP lazy namespaces | 工具目录分两级：常驻核心 + 按需发现（`tool_search`/skills）；MCP 命名空间懒加载 | M/★★ | P2 |
| 7 | 代码化调用（PTC/code mode） | 无 | Cloudflare Code Mode、smolagents CodeAgent、DSH ptc-runtime | 受限沙箱内批量调用工具（一次推理完成多步），先用于本地工作区/终端任务 | L/★★ | P3 |
| 8 | 并行/批处理 | 只读批处理（opt-in，已实现） | 并行 tool calls、subagent fan-out | 默认开启并行只读（评测验证后）；写入保持顺序；并行批事件化 | S/★★ | P1 |
| 9 | 技能 | 静态 5 内置 + 本次文件化随需披露 | DSH skills 渐进披露、Anthropic Skills | 技能目录=文件系统；系统提示只放名称+描述；正文按需；技能可来自用户工作区/内置 | S/★★★ | P1（文件化已完成） |
| 10 | 子代理 | 无 | DSH subagent、OpenHands child conversation、Claude Code subagents | 两个受限场景：①研究/检索汇总子代理（返回 1–2K token 摘要）②独立验证子代理（第二意见） | L/★★★ | P2 |
| 11 | 多代理/团队 | 无 | DSH agent-team、workflow、handoff | 暂不做通用团队；先"主管-工人"两角色，事件化结果，成本上限硬约束 | L/★★ | P3 |
| 12 | 记忆 | memory store 骨架（未学习） | Mem0/Zep/Letta、post-task memory write | 三类记忆：episodic（任务复盘）、procedural（验证过的流程）、semantic（用户偏好/事实）；任务后写入、按需检索 | M/★★★ | P1/P2 |
| 13 | 失败学习 | 失败轨迹只人工分析 | 轨迹挖掘、失败案例库、GEPA/DSPy 式优化 | 失败分类账本 + 自动从轨迹提取失败模式 → 回归用例/提示修订 | M/★★ | P2 |
| 14 | 验证/收敛 | 验收 + 修复轮（本次） | 独立 verifier、judge、self-consistency | 验收标准双层（产物存在性 + 内容契约）；修复轮扩展到 2 次带预算；独立验证子代理（P2） | M/★★★ | P1 |
| 15 | 可靠性 | 有界重试/超时/网络/截断续跑 | durable execution、rainbow deploy、确定性重试 | 所有边界条件事件化；升级不打断在途任务（版本化执行器）；重放验证 | M/★★★ | P1/P2 |
| 16 | 沙箱/执行环境 | 本地 workspace + docker（评测侧） | E2B/Daytona/Firecracker、browser-use | 本机/云端统一执行接口；网络白名单；资源上限；computer-use 后续 | L/★★ | P3 |
| 17 | 权限/审批 | Manifest 门控 + 审批 + 幂等 | execpolicy 规则、granular approval、sandbox roots | 审批规则化（前缀规则/风险分级）、审批决定单一权威、记入事件 | M/★★ | P1/P2 |
| 18 | 可观测/追踪 | 逐请求 telemetry + 前缀指纹 + 本次 run.summary | OTel GenAI、Langfuse/Phoenix、trajectory trace | run 级汇总 + 会话级 trace + 成本账本；OTel 导出（P2）；失败回放 | M/★★★ | P1 |
| 19 | 评测/回归 | 外部基准 + 手工实验 | 20–50 golden tasks CI、在线 A/B | 内部 golden 回归集（产品入口+工具+安全）；CI 闸门；变更前后对比 | M/★★★ | P1 |
| 20 | 提示/缓存 | 前缀指纹观测，策略候选默认关 | request header 缓存纪律、prompt_cache_key | 默认开启稳定前缀策略（A/B 通过后）；阶段/工具 schema 排序稳定化 | M/★★ | P1/P2 |
| 21 | 模型路由/分级 | 阶段级推理档位 + max 标准臂 | effort tiers、模型级联、escalate-on-failure | 档位按任务类型/阶段；失败升级档；成本上限；路由决定事件化 | S/★★ | P1 |
| 22 | 结构化输出 | 有 JSON 协议校验 | 严格 schema、重试修复 | 工具参数/文档计划/研究结论结构化 + 校验失败修复轮 | M/★★ | P1 |
| 23 | 协议互操作 | 无 | MCP、A2A、OpenAPI | MCP 客户端（stdio+HTTP）优先；A2A 观察 | L/★★★ | P2 |
| 24 | 长程/主动 | 无 schedule/goal | 目标轮次、定时任务、proactive agents | 复用现有 schedule/goal 概念，做"任务续跑+提醒"，不做全自主 | M/★★ | P3 |
| 25 | 不确定性与人工 | 审批/暂停/needs_input | HITL、置信度门控、approval UI | 高影响动作前显式确认；不确定时列出证据与缺口（已有部分） | S/★★ | P1 |
| 26 | 成本治理 | 预算硬停 + 供应商成本遥测 | 成本账本、token 预算、缓存感知 | 每任务成本预估 + 实时账本 + 超支前预警；缓存命中纳入指标 | S/★★★ | P1 |
| 27 | 多模型/自托管 | 单端点 | 多 provider 抽象 | 保持 provider 抽象（已有），加模型能力矩阵与降级链 | M/★★ | P2 |
| 28 | 多模态 | 图片输入/愿景 | 截图 computer use、vision tools | 先做图片理解+文档截图回读；不做实时 UI 自动化 | L/★★ | P3 |
| 29 | 语音/UI | Web/SSE | - | 保持 | - | - |
| 30 | 自进化 | 无 | 轨迹→用例→提示/工具修订（人审） | 失败模式库 + 自动生成候选修复 → 人工审 → 回归验证 | M/★★ | P3 |

**"脑洞"清单（超出常规但值得记录）**：投机式工具预取（读类缓存预热）、KV-cache 感知的提示布局
（稳定前缀/动态尾部做 A/B）、任务级预算预估器（历史相似任务成本）、失败轨迹自动聚类成回归用例、
"计划-执行-复盘"三阶段记忆写入、技能合成（从成功轨迹提取 SKILL.md 草稿）、
重放式调试（事件日志 + 决定重放）、多模型一致性对照（同一任务双模型跑，差异即风险）、
对抗自测（让 agent 攻击自己的交付物）、成本-质量帕累托前沿（每类任务选最优点）。

## 2. 目标架构 v2 模块图（依赖方向自上而下）

```
api/SSE ──> runtime/worker（任务生命周期、lease、检查点）
              │
              ├── core/session（事件日志权威：append/derive/replay/repair）
              │        └── core/event-log（本次已交付，Phase 2 持久化）
              ├── core/loop（turn/step 循环、steering、守卫、预算）
              │        ├── core/context（分层预算、压缩、spill、前缀布局）
              │        ├── core/tools（schema/管道/结果信封/并行/审批）
              │        ├── core/plan（todo/计划文件，持久化）
              │        └── core/verify（独立验收 + 修复轮）
              ├── core/delegate（受限子代理：研究汇总/独立验证）
              ├── core/memory（episodic/procedural/semantic + 写入/检索）
              ├── core/skills（文件目录 + 渐进披露，已交付）
              ├── core/mcp（客户端 + 命名空间懒加载，P2）
              ├── core/telemetry（run.summary/成本账本/OTel，P1）
              └── core/protocol（native/JSON/PTC 适配）
```

**边界原则**：`session` 不依赖 loop；`loop` 只依赖抽象（transport/tool executor/verifier/memory 接口）；
worker 组装；所有横切能力走 hooks（审批/预算/遥测），不侵入循环。

## 3. 分阶段重构计划

| Phase | 内容 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| **P0（已完成）** | 事件日志模块 + loop 双写（`a225d95`）；结构化压缩/todo/并行只读/修复轮/技能/JSON-safe spill/run.summary | `core/event-log.ts`、相关测试 | 678 tests 677 通过；事件可重放；双写顺序正确 |
| **P1（本迭代）** | ①事件日志持久化（store 适配器，跨 turn 连续）②resume 从事件重建消息（transcript 仅兼容）③计划持久化+注入 ④失败模式库初版 ⑤golden 回归集（20–30 条产品入口用例，CI）⑥成本账本 + 缓存命中指标 | store session log、replay-from-store、plan persistence、golden runner | 重启/崩溃后事件连续；resume 消息与 transcript 等价；golden 集绿 |
| **P2（下一迭代）** | ①研究/验证两个受限子代理 ②MCP 客户端（stdio+HTTP，工具命名空间/审批继承）③记忆写入与检索闭环 ④OTel 导出 + 轨迹可视化 ⑤工具渐进披露（tool search） | delegate 模块、mcp 模块、memory hooks | 子代理成本上限生效；MCP 工具可用；任务后记忆可检索 |
| **P3（观察）** | PTC/code mode、多代理团队、computer-use、A2A、自进化流水线 | 原型 | 单变量实验证明收益 > 成本 |

**实施纪律**：每阶段独立提交 + 全量测试；所有新机制带开关（env/配置），默认关或保守；
上线顺序 = 事件日志 → 上下文/计划 → 验证闭环 → 子代理/MCP → 其余；
任何机制只有在"机制指标 + golden 回归"同时改善时保留，否则回退。

## 4. 本迭代已落地（可复查）

1. `core/event-log.ts`：SessionEvent 词表、InMemorySessionLog、deriveMessages、replay、repairEvents、appendEvents（`a225d95`）。
2. `agent-loop.ts` 双写：turn/start、user/message、assistant/message、tool/call、tool/result、checkpoint、turn/end（15 处接入点）。
3. 测试：投影/配对/修复幂等/重放/双写顺序（`event-log.test.ts` + loop 集成测试）。

## 5. 与评测的关系

用户已决定停止 Terminal-Bench 失败集批次（3/35 完成，均 reward 0、CTRF 真实执行，证据保留）。
架构 v2 的验证不再依赖单个外部基准，而是三层：
1. **单元/集成测试**（机制正确性）；
2. **golden 回归集**（产品入口 20–30 条：登录、工作区、文档、审批、恢复、安全）；
3. **外部基准抽样**（AppWorld/OfficeBench/GDPval 失败集，作为端到端对照，不做全量刷榜）。

## 6. 参考

- `docs/specs/agent-architecture-comparison.md`、`docs/specs/architecture-references/*.md`
- `agent-arch-refs/research-agent-paradigms.md`、`research-github-solutions.md`、`research-dsh-deep.md`
- Anthropic：effective context engineering、advanced tool use、multi-agent research system
- DSH：`docs/subsystems/core.md`、`compaction.md`、`subagent.md`、`skills.md`、`mcp.md`
