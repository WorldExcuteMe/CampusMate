# CampusMate · DEVELOPMENT_PLAN.md

版本 0.1 · 2026-11-12 · 主提示词 §11/§15/§16 · 截止 2026-11-30

## 1. 研发工作流（每 Feature 必走）

Idea → Spec → Plan → Task → TDD → Implementation → Test → Preview → Review → CI → Merge → Deploy

每 Feature 交付：Spec、Acceptance Criteria、Plan、Test Cases、Implementation、Validation Evidence。
Subagents 做独立调研/测试/审查；并行开发工作区隔离（worktree）；主 Agent 最终集成验收。

## 2. 阶段顺序

- **Phase A 工程基础**：初始化、Migration、Auth、RLS、设计系统、Demo Mode。
- **Phase B Inbox**：文本/图片/PDF 输入、提取、分类、优先级、用户确认。
- **Phase C Radar**：种子数据、官方源、搜索筛选、详情、个性化匹配。
- **Phase D Trust**：来源核验、多源对比、证据、风险提示、报告。
- **Phase E Growth**：目标、规划、任务管理、成长档案、Dashboard。
- **Phase F 验收**：测试、UI 优化、Preview、Demo 测试、Sites 部署准备。

**第一条闭环优先**（PRODUCT_SPEC §6），在 Phase A/B 内最先跑通。

## 3. 时间表

| 阶段 | 日期 | 内容 |
|---|---|---|
| 1 | 11.12–11.14 | 工程初始化、数据库、设计系统 |
| 2 | 11.15–11.19 | Inbox |
| 3 | 11.20–11.22 | Opportunity Radar |
| 4 | 11.23–11.24 | Trust Engine |
| 5 | 11.25–11.27 | Growth Center + Dashboard |
| 6 | 11.28–11.30 | 测试、修复、Demo、Sites 部署、作品材料 |

预留部署与故障修复时间；不为扩展牺牲核心闭环。

## 4. 执行纪律（主提示词 §17）

先查工作区；复用 Phase 0 研究；实现前出 Spec/Plan；大任务拆小可验证；互不冲突工作并行；每模块跑测试；不积累未验证代码；不用 Mock 假装真实完成；不擅自扩 MVP。
缺凭证：不编造、不停摆，先 Mock+接口抽象，文档标记待人工配置。重要架构决策记 ADR；跨模块业务变更先更新 Spec。

## 5. 协作与集成

GitHub Issues/Branch/PR/Review；分支 `feat/<slug>`、`fix/<slug>`，PR base=main；合并前测试+Preview 证据；push 与公开访问需用户确认。三人分工见 project.md §2。

## 6. 当前进度

见 project.md §4（实时）。本文件随阶段推进更新。