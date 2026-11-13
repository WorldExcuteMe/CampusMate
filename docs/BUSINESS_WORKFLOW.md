# CampusMate · BUSINESS_WORKFLOW.md

版本 0.1 · 2026-11-12 · 业务链路与状态机

## 1. 核心业务链路

```
User Input → Intent Router → Domain Workflow → Structured Output
→ Zod Validation → Business Rule Validation → User Confirmation
→ Database Persistence → Activity Logging
```

任何 AI 产出必须经 Schema 校验 + 业务规则校验 + 用户确认后才落库；每步写 activity_events。

## 2. 第一条闭环（Inbox → Task → Dashboard）

1. 用户在 Inbox 输入通知文本（或上传文件/URL）。
2. 解析为标准文本（txt 直用；pdf→PDF.js；docx→Mammoth；图片→Vision/OCR）。
3. Intent Router 判定 `inbox.extract`。
4. Information Extractor 产出结构化字段（Zod 校验）。
5. Classification Engine 定五类之一；Priority 引擎算优先级（与匹配度分离）。
6. 展示结构化结果供用户**确认/修改/忽略/收藏/生成待办**。
7. 确认后保存 inbox_items（状态 confirmed）。
8. 用户生成待办 → tasks（关联 inbox_item）。
9. Dashboard 聚合展示待办与近期截止。
10. 全程 activity_events + agent_runs 记录。

## 3. 状态机

- inbox_items.status：`pending_review → confirmed | ignored | archived`；提取失败 `failed`（可重试）。
- opportunities.status：`active → expired | archived`；核验状态独立字段。
- verification_reports.status：`VERIFIED | PARTIALLY_VERIFIED | UNVERIFIED | CONFLICTING | RISK_FLAGGED`。
- tasks.status：`todo → in_progress → done | cancelled`。
- goals.status：`active → achieved | abandoned`。
- agent_runs.status：`running → succeeded | failed | timeout`。

## 4. 机会匹配流程

硬性资格过滤（年级/专业/资格不符直接排除并给理由）→ 软性加权评分（兴趣25/技能25/目标20/时间15/经验15，权重存 user_preferences 可配）→ 生成 match_assessments（分数+分项+可解释理由）→ 用户收藏/忽略/核验/建计划。

## 5. 核验流程

选择机会 → Trust Verifier 收集多源证据（官方来源白名单优先）→ 逐项核对（主办方/域名/收费/资格/截止/一致性）→ 每条结论挂 evidence_items → 汇总状态 → 生成 verification_report。**无证据不下结论；无法核验=UNVERIFIED，不等于诈骗**。

## 6. 成长流程

用户建目标 → Action Planner 依机会+目标生成计划（阶段/子任务/依赖/截止/工时）→ 用户确认/修改 → 创建任务 → 执行/完成 → 用户确认后写入成长档案。

## 7. 角色与确认点

| 环节 | 执行 | 确认点 |
|---|---|---|
| 提取/分类/优先级 | Agent | 用户审核结构化结果 |
| 匹配 | Agent | 用户查看理由后操作 |
| 核验 | Agent+证据 | 用户查看报告 |
| 计划/任务 | Agent 建议 | 用户确认才创建 |
| 成长记录 | 系统汇总 | 用户确认才正式 |

原则：Agent 不绕过业务层改库；不未经确认批量建任务。