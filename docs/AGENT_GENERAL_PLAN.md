# CampusMate 通用 Agent 能力规划 · DSH 对标量化 · Benchmark

> 目标：不脱离「校园机会管家」核心诉求（QQ/微信群信息本位摄取 + 机会管理），把 agent 升级为能自主执行
> 复杂资料搜索/整合/总结长任务的通用 agent。对标 DeepSeek Harness（dsh）成熟内核。

## 1. 现状 Review 与覆盖率

- 覆盖率（vitest v8）：全 src 行覆盖 **9.38%**（含大量未单测 UI 组件）；**lib 逻辑层 43.75%**。
  核心模块：classifier/context/dedupe/scope/reasoning/schemas/urlGuard/tools ≈ **94–100%**；
  chat.ts（agent 循环）0%（靠浏览器集成验证，待补单测）；llm/proxy 41%；ingest/qq 59%；data/demo 69%。
- 已修复根因：代理瞬断自愈（serve.mjs）、上游错误对象透传（不再 [object Object]）、摄取普适化
  （工具入仓+python/QQ目录自动探测+自动解密+错误分类）、压缩三层分离（截断≠压缩）、信息全类别、
  save_to_inbox 落库、对话去噪。
- 本轮补齐容器写入：`create_opportunity`(雷达)、`verify_opportunity`(核验)、`set_growth_goal`(成长)、
  `web_search`(广泛搜索)、`create_plan`(长任务计划) + `memory.ts`(计划/滚动记忆 checkpoint)。
  Repository 增 `createReport`（demo+supabase），使可信核验可写。

## 2. 长任务 / 记忆 / 抗幻觉设计（移植 DSH 内核）

- **plan-mode（DSH packages/plan）**：`create_plan` 生成分步计划（收集→核验→整合→总结→落库），
  持久化 `campusmate.plan.v1`，每轮注入 system；按未完成步骤推进，不重复已完成步骤。
- **goal-round-driver（DSH packages/goal）**：长任务以 goal 驱动多轮自续，设 round 上限防无限循环；
  每轮结束 `appendMemory` 写「已核实事实+来源」checkpoint（`campusmate.memory.v1`，保留最近12条），
  跨轮注入，保证连续长任务不丢记忆。
- **抗幻觉**：记忆只记已核实事实+来源；SYSTEM 规则禁止编造、查不到≠不存在、无法核验≠诈骗；
  工具结果截断/spill 带取回提示；repeat-tool-reminder 防死循环重试；错误真实透传。
- **上下文**：三层分离（执行期 spill / 历史期 prune / 历史期 compaction），阈值
  min(窗口×0.8, 窗口−预留−65536)、保留尾16%；200K 工作上限（DeepSeek V4 1M 能力内）。

## 3. 通用 Agent 大型计划（头脑风暴 → 路线）

核心诉求不变：校园信息本位 + 机会管理。通用能力作为「可按需调用的扩展」，不喧宾夺主。

- **P0（已落地）**：容器全写入（inbox/日常/雷达/核验/成长）；web_search 广泛搜索；plan+memory 长任务；
  作用域锁定（用户指定 QQ 群则源内，未指定/要求网页则放开全工具）；自主多步（MAX_TOOL_ROUNDS=20）。
- **P1（下一步）**：
  - 子代理隔离（DSH subagent）：并行查多群/多源，depth 上限、审批钉死、只回最终输出，父代理 steer 接收。
  - 事件溯源会话日志（DSH core/session）：append-only + surface 折叠，崩溃修复补未闭合 tool 结果，
    请求前/副作用前 checkpoint fail-closed。
  - 检索增强：web_search 结果去重+来源可信度分级+官方白名单优先；RAG 向量召回（现关键词召回升级）。
  - 自主核验闭环：search→fetch 官方页→交叉比对→verify_opportunity 落报告，无需用户干预。
- **P2（增强）**：技能目录按需加载（DSH skill progressive disclosure）；校历/规章知识包；
  定时任务（qoder_cron/DSH schedule）主动巡检群与官网；多模型路由能力声明化；token 计量影子价格协议。

头脑风暴要点：把「通用」做成**工具与策略的可组合层**（DSH 一切皆插件思想），核心校园诉求作为默认
profile/preset；用户提示词触发通用工具时自动切换 scope，不强制用户配置。长任务用 plan+goal+memory
三件套保证「自主但不失控、连续但不失忆、广泛但不幻觉」。

## 4. DSH 对标能力量化（0–5 分）

| 维度 | DSH | CampusMate 现状 | 差距/路线 |
|---|---|---|---|
| 工具广度（读写/搜索/终端/文件） | 5 | 4 | 补子代理/沙箱分级 |
| 容器写入（inbox/任务/机会/核验/成长） | 5 | 4 | 已全写入，待集成单测 |
| 长任务 plan/goal 自续 | 5 | 3 | plan+memory 已有，goal-round/子代理待补 |
| 会话记忆/崩溃修复 | 5 | 3 | checkpoint 已有，事件溯源待补 |
| 抗幻觉/来源核验 | 4 | 4 | 持平，补自动交叉核验闭环 |
| 上下文管理（三层分离/阈值） | 5 | 4 | 已移植，补影子价格计量 |
| 模型无关/路由 | 5 | 4 | 已适配 OpenAI 兼容+effort 映射 |
| 自主性（无干预完成度） | 5 | 3 | 补自主核验闭环+定时巡检 |
| 测试覆盖（核心逻辑） | 4 | 4 | 核心94–100%，chat 循环待补 |
| 部署/自愈 | 4 | 4 | serve 自愈+Edge 回退 |

综合：DSH ≈ 4.7/5；CampusMate ≈ 3.7/5。P1 完成后预计 4.3/5。

## 5. Benchmark 提示词集（检验综合能力）

日常/容器写入：
1. 「把『周五19:00 班会』建为日常任务，并设定成长目标『本周完成班会材料』。」→ 断言 tasks+goals 新增。
2. 「总结群 881289395 通知，过期不要，合并进 inbox，并把仍有效的竞赛写入机会雷达。」→ 断言 inbox+opportunities 新增、无过期项。

核验/成长：
3. 「核验『华为ICT大赛』机会的真实性，给出报告与证据。」→ 断言 verification_reports 新增、含来源。
4. 「把『11月底前完成华为ICT创新赛报名』设为成长目标并建跟踪任务。」→ 断言 goals+tasks。

广泛搜索/通用：
5. 「网页搜索『2026 全国大学生 计算机 竞赛 报名』，整合前5条并总结，写入机会雷达。」→ 断言 web_search 调用+opportunities 新增+来源真实。
6. 「搜索『太原理工大学 2026 实习 招聘』，区分官方与第三方，给出可信度分级。」→ 断言来源分级、不编造。

长任务/记忆/抗幻觉：
7. 「全面收集我所在群的求职+比赛信息，分步计划执行，最后总结并落库。」→ 断言 create_plan+多轮+memory checkpoint+落库。
8. （接续7）「继续上次的长任务，从上次进度继续，不要重复已完成步骤。」→ 断言记忆/计划续跑、不重复。
9. 「群里没提到的比赛，不要编造；查不到就说查不到。」→ 断言不幻觉、如实说明。
10. 「只在我指定的 QQ 群内找信息，不要网页搜索。」→ 断言 scope 锁定、web_search 不被调用。

自主性：
11. 「自主完成：收集→核验→整合→总结→落库，全程不要问我。」→ 断言无干预完成闭环。

每条断言对应容器/工具调用/记忆/来源，可自动化为 E2E benchmark。

## 6. 短提示词 + 全新环境 自主能力考验（真金白银测试用例）

目标：新开文件夹/新会话，仅一句短提示词，agent 自主完成「环境配置→检索→总结→落库」，无需人工干预。
自主链：detectScope→(无密钥自动 bootstrap 取钥+解密)→list_groups 定位→sync_group_notices→
rag/总结→save_to_inbox/create_opportunity/create_daily_task→merge_inbox。失败才降级引导。

短提示词用例（全新环境逐条测）：
1. 「去QQ群881289395拿通知。」→ 自主 bootstrap+定位+摄取+总结+落库。
2. 「帮我看看班级群最近有什么要做的。」→ 自主定位通知群+提取日常事务+建任务。
3. 「总结我们群的比赛信息。」→ 自主定位+全类别归纳+写雷达。
4. 「群里有什么奖学金/补助消息？」→ 自主检索生活/奖助类+落库。
5. 「把群通知整理成待办。」→ 自主提取含时间项+create_daily_task。
6. 「最近有什么可以报名的？」→ 自主过滤过期+只留未过期+写雷达。
7. 「微信群里看看班会通知。」→ 微信源自主摄取+日常任务。
8. 「帮我收集求职信息并总结。」→ 无群源时自主 web_search+整合+落库（通用能力）。
9. 「全面整理我群里的机会，分步做。」→ create_plan+多轮自主+memory+落库。
10. 「继续上次没做完的整理。」→ 记忆/计划续跑不重复。

判定标准：无人工干预完成闭环；容器有新增；来源真实；过期剔除；不编造；失败给可操作提示而非静默 Mock。