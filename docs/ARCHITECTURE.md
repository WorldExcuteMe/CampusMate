# CampusMate · ARCHITECTURE.md

版本 0.1 · 2026-11-12 · 模块化单体（主提示词 §4）

## 1. 逻辑架构

```
Frontend (React SPA, Vite 构建)
  │  React Router / TanStack Query / Zod / 设计系统
  ▼
Supabase API / Edge Functions
  ├─ Authentication (Supabase Auth)
  ├─ User Profile Service
  ├─ Inbox Service
  ├─ Opportunity Service
  ├─ Trust Service
  ├─ Growth Service
  ├─ CampusMate Agent Orchestrator
  ├─ LLM Provider Adapter（Key 仅服务端）
  └─ Data Collection（白名单来源）
  ▼
PostgreSQL（RLS）+ Storage
```

不引入微服务；模块间通过清晰接口协作；Agent 不得绕过业务层直接改库。

## 2. 部署架构（Qoder Sites 适配）

- **Qoder Sites**：托管 Vite 静态构建产物（`web/dist`），最终公开访问供评委体验。
- **Supabase**：唯一外部业务后端（DB/Auth/Storage/Edge Functions）。**不在 Sites 重复建业务数据库**。
- 前端通过 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` 连接 Supabase；模型密钥只在 Edge Function 环境变量。
- 开发阶段私有；发布与公开访问变更需用户确认。
- 兼容性验证项（Task #7）：Vite build 产物可被 Sites 静态托管、SPA 路由回退、环境变量注入方式、构建体积限制。

## 3. 前端结构（web/）

```
web/src/
  app/            # 路由、布局、providers
  components/ui/  # 设计系统（shadcn 风格基础组件）
  features/
    inbox/  radar/  trust/  growth/  dashboard/  auth/
  lib/
    agent/        # Orchestrator + 工具 + Zod schemas（共享，可跑在浏览器/Edge）
    llm/          # Provider Adapter：mock / openai-compatible
    data/         # Repository 接口：supabase 实现 + demo 实现（明确标识）
    parse/        # pdf.js / mammoth / 文本归一化
    security/     # URL 校验、SSRF 防护（采集侧）
  demo/           # Demo 种子数据（虚拟档案+通知+机会+任务+报告）
```

规则：组件化、统一设计系统/布局/错误状态；桌面+移动；页面间不重复业务实现（业务逻辑下沉 features/lib）。

## 4. 数据层策略（ADR-003）

- `Repository` 接口统一 Inbox/Opportunity/Task/Profile 等操作。
- **SupabaseRepository**：真实用户模式，RLS 隔离，Migration 管理 schema。
- **DemoRepository**：Demo Mode 专用，localStorage 持久化，数据带 `demo` 标识，**只读真实数据、不可写真实数据**。
- 无 Supabase 凭证时应用以 Demo Mode 运行并显著标识；配置凭证后启用真实模式。Demo 不是「假装真实功能」，而是隔离的演示数据层。

## 5. AI 层（ADR-004）

- Agent 核心（Intent Router / Extractor / Classification / Matcher / Verifier / Planner / Context Manager）为共享 TS 模块，输入输出均 Zod Schema。
- LLM Provider Adapter：`LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`；支持结构化输出、图片理解、超时+有限重试、成本记录、Mock Provider。
- Demo：浏览器内跑 Mock Provider（确定性规则提取，明确标识 MOCK）。
- 生产：Edge Function 调真实模型，Key 不落前端；同一套 Schema 与业务规则。

## 6. ADR 清单

| # | 决策 | 状态 | 依据 |
|---|---|---|---|
| ADR-001 | 模块化单体 React+Supabase，不上微服务 | ACCEPTED | 主提示词 §3/§4 |
| ADR-002 | Sites 托管静态前端 + Supabase 外部后端，不重复建库 | PROPOSED | 主提示词 §3.7；待 Task #7 验证 |
| ADR-003 | Demo 本地数据层与真实数据隔离，无凭证跑 Demo+Mock | PROPOSED | 主提示词 §9/§17 |
| ADR-004 | Agent 共享 TS + Mock/真实双运行位置，Key 仅服务端 | PROPOSED | 主提示词 §3.3/§6 |
| ADR-005 | 开发私有，发布/公开需用户确认 | ACCEPTED | 用户指定 |

## 7. 技术风险

| 风险 | 缓解 |
|---|---|
| Sites 对 SPA 路由/体积限制未知 | Task #7 先验证最小构建产物 |
| 无 Supabase/LLM 凭证 | Demo+Mock 先跑通；接口抽象就绪；文档标记待配置 |
| 时间紧（11.30 截止） | 核心闭环优先；模块按 Phase A–F 顺序；不扩 MVP |
| 提取准确率 | 测试集评估（TEST_PLAN）；用户确认兜底 |