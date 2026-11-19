# Agent 架构对比与大优化构建（2026-11-19）

> 目的：回答"我们的 agent 架构与顶级 agent 差在哪、能学什么、怎么落地"。
> 方法：本地 DeepSeek Harness 源码全量阅读（`C:\Users\Asus\CodeBuddy\dsh-src`，官方仓库
> `deepseek-ai/deepseek-harness`）+ 四个开源参考仓库（OpenAI Codex CLI、Google Gemini CLI、
> OpenHands、SWE-agent、Aider）逐维度分析 + 对 CampusMate 自身 14,882 行非测试代码的逐模块审计。
> 四份完整分析见 `docs/specs/architecture-references/`（analysis-dsh / analysis-ours /
> analysis-cli-agents / analysis-py-agents）。本文件是对比结论与落地清单。

## 0. 参考对象与执行模型

| 项目 | 形态 | 执行模型 | 最适合借鉴的点 |
| --- | --- | --- | --- |
| DeepSeek Harness (DSH) | TS monorepo，插件化 | **append-only session log + deriveMessages()**；turn/step 显式分层，step = 认领 inbox → 组装 prompt → pre-step 瀑布（可拒绝/重写）→ 只记录变化的 request header → 流式 → 派发工具 → 追加事件；resume=重放，崩溃修复=追加 interruptedTurnClosers | 事件溯源会话日志、两车道 inbox、request header 缓存纪律、compaction 事务化、渐进披露 skills |
| OpenAI Codex CLI | Rust workspace | 单一 submission/event bus（Op/EventMsg）；turn 内多 step，每请求 `StepContext`；append-only `ResponseItemEnvelope` 历史 + world-state diff；execpolicy 前缀规则 + granular approval + sandbox writable roots；Guardian 独立 LLM 审查；47 类 typed context fragment | 工具调用的事件化协议、turn/step 记录、execpolicy 式审批规则、head/tail 截断策略、子代理（LocalAgentControl） |
| Gemini CLI | TS monorepo | `sendMessageStream → processTurn → Turn.run`；`Scheduler` 调度工具（MAX_TURNS=100），哈希式循环检测 + next-speaker 检查；MessageBus 异步确认；双工具结果（llmContent vs returnDisplay）；tool output masking + 50% 压缩（保护最近 3 轮、折叠到 2KB） | 双工具结果、输出遮蔽/压缩两级衰减、PolicyEngine 优先级审批、会话作用域隔离 |
| OpenHands | 当前主线为 Agent Canvas 前端 + 独立 software-agent-sdk | 服务端 append-only 事件日志，WebSocket 按 seq 游标重放 + REST 回填；`launch_child_conversation` 异步子会话（独立工作树） | 事件日志/游标回放、condenser（LLMSummarizingCondenser max_size=100/keep_first=6）、子代理异步握手 |
| SWE-agent | Python | 显式 `while not done: step()`，每步 `.traj` 落盘；SWE-ReX 远程环境；错误后自动提交部分补丁（model.patch） | ACI 设计：窗口化 viewer/editor、list-only search、提交工具、lint 拒绝编辑、空输出提示、state_command 快照 |
| Aider | Python REPL | 人类每条消息触发：send → apply edits → commit → lint → test → 有界反思（≤3）；tree-sitter + PageRank 的 repo map（1/8 上下文，≤4096）；architect→editor 双模型 | repo map、SEARCH/REPLACE 编辑协议、自动 commit/undo、双模型分工 |

一句话总结：**顶级 agent 的差异不在"更大的循环"，而在"可回放的状态 + 受控的工具界面 + 可验证的收敛"**。

## 1. 维度对比矩阵

| 维度 | DSH | Codex CLI | Gemini CLI | OpenHands | SWE-agent | Aider | **CampusMate（我们）** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 执行模型 | 事件日志投影 | turn/step + 事件总线 | turn + Scheduler | 事件日志 + WS 游标 | 显式 while 循环 | REPL 循环 | 单循环 `agent-loop.ts` + 检查点（可恢复） |
| 会话状态 | 类型化事件、纯投影 | 事件 + diff 基线 | 消息流 | 事件 seq | 每步 traj | 消息历史 | transcript + checkpoint JSON（无类型化事件投影） |
| 上下文压缩 | compaction 事务（bracket 替换、保留 16%） | head/tail 截断策略 | 遮蔽 + 摘要两级（50% 触发） | condenser（100/6） | 窗口化视图 | repo map + 历史裁剪 | **本次升级：结构化摘要（目标/计划/产物/证据/未完成）**；spill head+tail |
| 工具协议 | 显式 allowlist + 输出 schema + 审批瀑布 | 事件化工具调用 + execpolicy | 双结果 + 优先级 Policy | 事件化工具调用 | ACI 工具包（窗口化） | SEARCH/REPLACE + lint 门 | 原生/JSON 双协议 + 校验/幂等/审批包装；**本次：todo_write** |
| 并行/调度 | 工具批 + 子代理 | 子代理 + 并行 | 工具批 + 循环检测 | 子会话 | 单步串行 | 单步 | **本次：并行只读批处理（opt-in，预算门控、顺序保持）** |
| 规划/Todo | durable todo 工具 + plan mode | 计划 + Guardian | 计划/待办内置 | 计划事件 | 显式提交 | 人类驱动 | **本次：todo_write + 计划提醒**（此前无） |
| 子代理 | 完整 subagent（角色/分叉/深度/并发上限） | LocalAgentControl | 隔离 registry | launch_child_conversation | 无 | 双模型分工 | 无（审计第一梯队缺口） |
| 技能 | 渐进披露目录（名+描述，按需拉正文） | 内置命令 + 扩展 | 扩展 | microagents | 工具包配置 | 无 | 静态 5 个内置技能（`skill_open`，dev runtime；未接文件系统 skills/） |
| MCP | 完整 mcp-client（连接/凭据/截止/诊断） | 命名空间懒加载 MCP | 支持 | 支持 | 无 | 无 | **无（生态缺口）** |
| 权限/审批 | approval + sandbox 双层，fail-closed | granular approval + sandbox roots | PolicyEngine + sandbox | 沙箱/审批 | 无 | 无 | 审批 + 幂等 + 能力 Manifest（云端默认无本机工具） |
| 恢复 | 重放 + 崩溃追加关闭事件 | checkpoint + 事件 | 会话恢复 | 事件回填 + 沙箱恢复 | 每步保存 + 部分补丁 | auto-commit/undo | **本次新增：验收→修复轮（一次有界重入）**；检查点/重试/网络重试已有 |
| 可观测 | token-meter、session-telemetry、OTel | 事件日志 | 遥测 | 事件流 | 轨迹 | 日志 | 逐请求 telemetry（含 cache/reasoning/cost/requestId）+ 前缀指纹；无 run 级汇总 |
| 提示缓存 | request header 仅变化时记录；稳定前缀纪律 | prompt_cache_key | 稳定前缀 | — | — | — | 前缀指纹观测 + 候选策略（默认关，A/B 未做） |
| 模型路由 | 多模型 + 档位 | 模型选择 | 模型选择 | 多模型 | 单模型 | 双模型 | 阶段级档位（auto/max 等）+ 本次标准臂 max |

## 2. CampusMate 现状与差距排序（审计结论）

审计详见 `architecture-references/analysis-ours.md`（16 维能力矩阵 + 10 条缺口 + 3 个候选改造）。
按"对基准通过率影响 / 改造风险"排序：

1. **验收失败后没有修复闭环**（Evaluator 只决定状态，不回到循环；`RecoveryEngine` 只在测试里用）→ **本次已实现**。
2. **规划/todo 不在通用循环里**（`planner.ts` 的 `nextReadyStep` 无生产调用者；checkpoint 的 `stepProgress` 恒为 `{}`）→ **本次已实现最小闭环**（计划工具 + 提醒；checkpoint 持久化留待后续）。
3. **上下文压缩是"提取"不是"重建"**（旧实现每消息 160 字符平铺摘要；丢失产物/证据/未完成信息）→ **本次已升级结构化压缩**。
4. **并行只读是死代码**（`READ_PARALLEL` 声明未使用，generation-policy 却鼓励同轮多读）→ **本次已接线**（opt-in）。
5. **工具结果裁剪按字符 head/tail，可能截断 JSON**，且提示中宣传不存在的 `rag_search`；建议按 JSON/结构化边界裁剪。
6. **记忆不学习**（`addEpisodic/addProcedural` 无生产调用者）。
7. **技能只覆盖 dev runtime，且没有读取仓库 `skills/*/SKILL.md`**（DSH 式渐进披露未实现）。
8. **无 steering、无子代理、无 MCP**（架构级缺口，需专门迭代）。
9. **前缀缓存策略闲置**（`prefix-trace.ts` 455 行只观测；tail-stable 合并与 effort lock 需 `CM_PREFIX_POLICY=1`）。
10. **遥测最后写入覆盖 / 审批双权威**（`worker.ts` lastRequest 覆盖；`toolRequiresApproval` 未被使用）。

## 3. 本次大优化构建（已落地，含测试）

借鉴优先级：**不搬 DSH 的重型事件溯源/插件 DI 体系**（对 1.4 万行产品代码是过度工程），只取"可回放状态 + 受控工具界面 + 验证收敛"三原则中最贴合产品的最小机制。

| # | 机制 | 借鉴来源 | 实现 | 提交 |
| --- | --- | --- | --- | --- |
| 1 | **结构化压缩 v2**：摘要保留【目标】【计划】【产物】【证据】【未完成/错误】【最近步骤】；保留稳定 marker 供前缀追踪 | DSH compaction / Gemini 两级压缩 | `core/context.ts` 重写摘要器 + 压缩测试（产物/URL/失败保留、配对完整） | `aa2e445` |
| 2 | **TodoWrite 计划工具**：整表替换、三态、进度反馈；工具存在时注入计划规范，多步写入任务 4 轮无计划给一次提醒 | DSH todo / Claude Code TodoWrite | `runtime/workspace-tools.ts` 新增 `todo_write`；`agent-loop.ts` 注入 `【任务计划】` 与 `【计划提醒】` | `aa2e445` |
| 3 | **并行只读批处理**：整批只读 + 无审批 + 工具预算余量足够时并发；观测顺序保持，写入/审批仍串行；事件 `tool.parallel_batch` | Codex 子代理/批处理、Gemini Scheduler | `agent-loop.ts`：`parallelReadSafe()` + Promise.all 预取；`deps.parallelReads` opt-in；串行/并行测试 | `aa2e445` |
| 4 | **验收→修复轮**：验收失败且无暂停/截断/预算超限/未恢复工具错误时，用未通过项做一次有界重入（≤6 轮、剩余墙钟 >90s），重算交付检查并重新验收；记录 `eval.repair` 事件 | DSH Evaluator 重入、OpenHands/SWE-agent 有界恢复 | `runtime/worker.ts`：`applyRuntimeCriteria` 抽取 + `prepareDelivery` 可重算 + repair 分支；worker 测试 fail→repair→pass | `235b37b` |
| 5 | **文件化技能 + 渐进披露**：`skills_list` 只返回名称+一句话说明，`skills_read` 按需读取 `skills/<name>/SKILL.md` 正文；仅在本地工作区（`includeSkills`）暴露，评测驱动不受影响；工具存在时注入 `【技能库】` 规范 | DSH 技能渐进披露 | `runtime/workspace-tools.ts` 新增两个工具（路径校验/大小上限）、`local-app.ts` 开启、`agent-loop.ts` 注入规范；测试覆盖目录扫描/正文读取/路径穿越拒绝/默认不暴露 | 本次提交 |
| 6 | 此前标准臂配套：预算自适应、停滞提醒、观测去重、网络重试、交付校验升级（逐文件观测）、web_fetch 重试、max 推理档位 | — | 见更早提交 | `5519895` 等 |

**验证状态**：全量后端 **670 项：669 通过、1 跳过、0 失败**；类型检查通过；评测侧标准臂配置（`reasoning_effort=max`、
32768 输出、240/360s 超时）独立于产品代码，评测快照隔离未被破坏。

## 4. 明确不采用 / 延后的设计（及理由）

- **事件溯源会话日志**（DSH 核心）：对 1.4 万行产品代码是架构级重写；收益（崩溃精确重放）当前由 checkpoint 部分覆盖。
  若未来支持多端实时协作再考虑。
- **完整子代理体系**：需要父子会话隔离、工作树/工具集继承、结果协议；产品暂无此需求场景，列入下一阶段。
- **MCP 客户端**：生态价值高（本会话横向对比也指出 MCP 是缺口），但需要连接管理/凭据/工具名冲突策略；
  建议作为独立迭代（1–2 周），而不是本次塞进循环。
- **文件系统 skills 渐进披露**：已实现（本轮第 5 项：`skills_list`/`skills_read`，读 `skills/*/SKILL.md`，按需披露）；
  旧的 5 个内置 `skill_open` 保留不动。
- **DSH/Gemini 的 in-loop LLM 微评审**（next-speaker、Guardian、循环双检）：会显著增加延迟与成本，
  本次评测显示端点长尾已经吃紧；先用确定性守卫（我们已有）替代。
- **前缀策略默认开启**：观测已就绪，但需要相邻时段 A/B 证明收益（缓存命中 vs 提示变动风险）后再默认开。
- **并行只读在评测驱动中启用**：机制已就绪（opt-in），但当前 Terminal 标准臂批次正在运行，为避免同批内配置漂移，
  在批次结束后再把 `parallelReads` 接入 Terminal/Office 驱动并单独标记。

## 5. 落地后的评测验证计划（与当前批次并行）

1. 当前 Terminal 失败集标准臂继续跑完（35 题，逐题 `jobs-ledger/<task>-max.tsv`），得到 baseline vs standard-max 对照；
2. 冻结新快照 `freeze-9`（含本次四个改动），对**失败集/未跑集**做单变量验证：
   - AppWorld 325d6ec_1（超时/交付）与 0d01c76_1（多步计划+恢复）；
   - OfficeBench 1-14/1（自检指令）、3-5/0（逐文件交付校验）；
   - GDPval 0005/0007（web 重试 + 修复轮）；
   - Terminal 失败集中"产物缺失/轮次上限"类任务（并行读 + 计划 + 修复轮）。
3. 记录机制级指标：并行批次数、计划工具使用率、压缩次数与摘要保留项、修复轮触发/成功数、tokens/时延/成本；
4. 只有机制级指标与通过率同时改善才算落地成功，否则回退对应机制（单变量原则）。

## 6. 参考文件

- `docs/specs/architecture-references/analysis-dsh.md` — DSH 子系统逐项拆解（14 维 + 8 条优先项 + 反过度工程清单）
- `docs/specs/architecture-references/analysis-cli-agents.md` — Codex CLI 与 Gemini CLI（11 维矩阵 + Top5）
- `docs/specs/architecture-references/analysis-py-agents.md` — OpenHands/SWE-agent/Aider（8 维矩阵 + Top6）
- `docs/specs/architecture-references/analysis-ours.md` — CampusMate 自身 16 维审计 + Top10 缺口 + 3 候选改造
- 本地 DSH 源码：`C:\Users\Asus\CodeBuddy\dsh-src`（origin `deepseek-ai/deepseek-harness`）
- 开源参考（浅克隆/离线包，2026-11-19）：codex、gemini-cli、openhands、swe-agent、aider（分析目录 `agent-arch-refs/`）
