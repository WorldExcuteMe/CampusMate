# 08 · Product IA（Stage 6）

> 基于真实代码。合并优先，不机械新增 7 页；真实数据接线。

## D1 · Feature Inventory（现有页面分类）

| 现有页面 | 路由 | 分类 | 说明 |
|---|---|---|---|
| DashboardPage | /app | REDESIGN→Today | 导航更名 Today；今日课程/待办/截止/通知/机会（today.ts 选择器） |
| AgentChatPage | /app/agent | REDESIGN→智能体工作台 | 已接后端 Task API（Stage 1）；后续增 Plan/Step/Evidence 展示 |
| InboxPage/Detail/New | /app/inbox* | KEEP | 真实 repository 数据 |
| DailyTasksPage | /app/daily | MERGE→任务与目标 | 导航更名；与 growth 协同 |
| RadarPage/Detail | /app/radar* | KEEP→机会中心 | 导航更名；匹配/资格/冲突后续增强 |
| TrustPage/Report | /app/trust* | KEEP | 可信核验 |
| GrowthPage | /app/growth | KEEP | 成长中心 |
| ProfilePage | /app/profile | KEEP | 个人画像 |
| SettingsPage | /app/settings | KEEP | 设置 |
| — | /app/calendar | NEW | 校园日历周视图 |

不删除任何现有页面/数据；仅更名导航 + 新增 Calendar。

## D2 · 统一业务对象（web/src/lib/domain/business-objects.ts）

Information / Task / Event / Opportunity / Reference 五类，`deriveFromInformation` 派生关联（竞赛通知→Opportunity+报名Task+截止Event），`buildRelationGraph` 双向关联图。不用单表代替所有对象。

## D3/D4 · 导航与核心页面

导航：Today / 智能体工作台 / 信息中心 / 校园日历 / 任务与目标 / 机会中心 / 可信核验 / 成长中心。
- **CalendarPage**（新）：周视图 7 天网格，真实课程（后端 /v1/schedules，单双周过滤）+ 任务截止 + 机会截止（repository）；空闲时间计算（≥30分钟）；教学周切换。
- **Today**：today.ts 选择器（今日课程/待办/7天截止/重要通知/推荐机会）。
- 后端 PersonalContext API：GET /v1/terms、/v1/schedules?termId、POST /v1/schedules/import（预览/确认）。

## D5 · 可视化

- 个人周课表 + 空闲时间（CalendarPage，calendar-grid.ts）。
- 今日任务优先级（today.ts）。
- Opportunity 匹配 / Agent 执行时间线：后续增量。

## 测试与 Preview

- 前端 vitest：**100 测试全过**（含 domain.test.ts 11：业务对象派生/周网格/单双周/空闲/今日）。
- 前端 build：**成功**（scripts/build.mjs）。
- 后端：**159 测试（158 过/1 skip）+ tsc 0**（课表 API 接入）。
- 注：dedupe.test.ts 在全量并发首跑偶发状态污染，隔离与重跑均通过（非确定性回归）。

## AC 状态

- AC14 Inbox/Task/Event/Opportunity 关联：**VERIFIED**（business-objects 派生+关联图测试）。
- AC15 Calendar 展示个人校园安排：**PARTIAL**（周视图+真实课程/任务/机会接线+build 通过；真实课表数据需 migration 0003 应用 + 导入）。
- AC16 Agent Workspace 真实任务状态：**PARTIAL**（已接后端 Task API/SSE；Plan/Step/Evidence 完整展示后续）。

## 后续
- Today 页面组件接线 today.ts（当前 Dashboard 统计保留，选择器已就绪）。
- Agent Workspace Plan/Step/Evidence/Approval 完整展示。
- Opportunity 匹配可视化 + Agent 执行时间线。
- 真实课表数据（migration 0003 + 三开发者导入）。