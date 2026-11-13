# CampusMate · TEST_PLAN.md

版本 0.1 · 2026-11-12 · 主提示词 §12 · 不得编造测试结果

## 1. 测试集（初始数据，Member C 维护）

15 条正常校园通知 + 10 条竞赛通知 + 10 条招聘信息 + 5 条科研招募 + 10 条风险案例 + 5 条信息冲突案例（共 55 条）。存 `web/src/demo/testset/`（标注来源/期望字段）。

## 2. 评估指标

字段提取准确率、日期提取准确率、信息分类准确率、机会匹配准确率、风险信号召回率、证据覆盖率、任务生成完整率。每项给出计算口径与实测值（Mock 与真实模型分别评估，明确标识）。

## 3. 自动化测试分层

| 层 | 工具 | 范围 |
|---|---|---|
| Unit | Vitest | extractor/classifier/priority/matcher/urlGuard/schemas |
| Component | React Testing Library | 关键组件交互与错误状态 |
| Integration | Vitest | Repository（demo）+ Agent 管线 |
| API | Vitest + Supabase | Edge Function 契约（有凭证后） |
| RLS | Supabase | 跨用户访问必须拒绝 |
| E2E | Playwright | 第一条闭环 + 主要页面 |
| Agent Eval | Vitest | 测试集跑指标 |

## 4. 第一条闭环 E2E（必过）

输入通知文本 → 提取标题/类别/截止 → Schema 校验 → 修改 → 确认保存 → 创建任务 → Dashboard 显示 → 刷新仍在 → 错误反馈。对应 PRODUCT_SPEC §6 十条验收。

## 5. Browser Preview（每主要页面完成后）

启动 dev server → Qoder Browser Agent/Playwright 打开 → 检查结构/交互/Console/网络请求 → 截图（存本地证据目录）→ 检查响应式 → 修复 → 重验。**不能只凭 Build 成功认定页面完成**。

## 6. 证据规范

每个测试结论附「命令 + 关键输出」；截图存 `C:\Users\Asus\CodeBuddy\campusmate-evidence\`；未覆盖项如实列出，空着比写错更贵。