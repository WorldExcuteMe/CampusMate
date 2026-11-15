# 09 · Personalized Workflow（Stage 7）

> 基于真实代码 core/workflows.ts。四条端到端业务链路，组合真实组件，非 mock。

## 四条工作流

### E1 Personal Campus Onboarding
`onboarding(store, input)`：学校/专业/年级 → 学期 → 课表导入预览 → **用户确认** → 保存 Profile+Term+Schedules+Sources 到 PersonalContextStore。
- 入口：POST /v1/workflows/onboarding。
- 持久化：PersonalContextStore（user_id 隔离）。
- 确认门控：confirm=false 仅预览，confirm=true 才落库。

### E2 Intelligent Campus Inbox
`intelligentInbox(input)`：信息 → 分类 → 优先级（截止紧迫度+机会加权）→ 时间冲突（截止日 vs 课程）→ 派生 Opportunity+Task+Event → needsConfirm。
- 入口：POST /v1/workflows/inbox。
- 组合：business-objects 派生逻辑 + occursInWeek。

### E3 Personalized Opportunity Discovery
`opportunityDiscovery(input)`：画像 → 资格筛选（年级）→ 技能匹配 → 兴趣/专业匹配 → 时间冲突 → 来源核验加权 → 评分排序推荐。
- 入口：POST /v1/workflows/opportunities。
- 输出：recommendations（score/eligible/matchReasons/timeConflict/verified/sourceUrl）。

### E4 Personal Weekly Planning
`weeklyPlanning(input)`：目标 → 课表/截止/任务 → 本周空闲计算 → 任务分配 → Plan DAG（planner）→ 冲突检查 → 验收（DAG 有效+无冲突+有分配）。
- 入口：POST /v1/workflows/weekly-plan。
- 组合：planner.planGoal/validateDag + occursInWeek + 空闲分配。
- 验收：acceptancePassed（no_expired + artifact）。

## 每链路要素

| 要素 | 实现 |
|---|---|
| 明确入口 | /v1/workflows/* API（JWT+owner） |
| 结构化输入 | OnboardingInput/InboxInput/OpportunityInput/WeeklyPlanInput |
| Agent 执行计划 | E4 planGoal DAG；E1-E3 确定性编排 |
| 可用工具 | schedule-import/personal-context/planner/verification |
| 数据持久化 | PersonalContextStore（E1） |
| 权限检查 | JWT + user_id 隔离；副作用操作须审批（工作流只产建议/计划） |
| 独立验收 | E4 acceptancePassed；E3 verified 加权 |
| 错误恢复 | 预览错误部分恢复；空闲不足冲突提示 |
| 前端展示 | Calendar/Today/机会中心（Stage 6） |
| 端到端测试 | workflows.test.ts + workflows-api.test.ts |

## 测试证据（AC17）

- workflows.test.ts（6）：E1 预览→确认→落库；E2 派生+优先级+冲突；E3 资格+技能+排序+时间冲突；E4 空闲分配+DAG+验收+空闲不足。
- workflows-api.test.ts（3）：onboarding API 预览→确认→terms；inbox/opportunities/weekly-plan API；无 token 401。
- 后端 **168 测试（167 过/1 skip）+ tsc 0**。
- **AC17 四条核心业务工作流：VERIFIED**（确定性端到端，组合真实组件）。

## 安全边界

工作流只产建议/计划/派生对象；报名/提交/发送消息/修改外部数据等副作用操作须按风险审批（Stage 5 审批门控），不为自主性取消用户控制。

## 后续
- 工作流前端入口页面（Onboarding 向导/Inbox 转换/机会推荐/周计划确认）。
- 真实高校数据端到端（三开发者 dogfooding）。
- E4 Plan 接入 Worker 实际执行 + Evaluator 证据核验。