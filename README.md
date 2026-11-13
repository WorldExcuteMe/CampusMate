# CampusMate · 校园机会管家

面向大学生的智能信息管理、机会发现、可信度核验与个人成长 Agent。

> 让重要信息不再被淹没，让有价值的机会真正变成行动。

## 核心链路

Information → Understanding → Discovery → Matching → Verification → Decision → Planning → Action → Growth

四大模块：**Campus Inbox**（智能收件箱）· **Opportunity Radar**（机会雷达）· **Trust Engine**（可信核验）· **Growth Center**（成长中心）。

## 技术栈

- 前端：React 19 + Vite + TypeScript + Tailwind CSS 4 + shadcn/ui + React Router + TanStack Query + React Hook Form + Zod + Recharts
- 后端：Supabase（PostgreSQL / Auth / Storage / Edge Functions / RLS），唯一业务数据源，Migration 管理
- AI：独立 LLM Provider Adapter（Mock / OpenAI-compatible），密钥仅服务端
- 测试：Vitest + React Testing Library + Playwright
- 部署：Qoder Sites（静态前端，公开 Demo）+ Supabase（外部后端）

## 开发

```bash
cd web
npm install
npm run dev        # 本地开发（默认 Demo 模式）
npm run test       # 单元测试
npm run build      # 类型检查 + 生产构建（dist/）
npm run preview    # 预览构建产物
```

无 Supabase 凭证时自动进入 **Demo 模式**：预设虚拟数据 + 明确标识的 Mock 提取，可完整体验第一条业务闭环。配置 `web/.env`（见 `.env.example`）后启用真实用户模式。

## 第一条业务闭环

导入校园通知 → 文本解析 → AI 提取 → 分类 → 优先级 → 用户确认 → 保存 Inbox → 生成待办 → Dashboard 展示。

## 目录

```
web/                 # React 应用（Qoder Sites 站点根）
  src/lib/agent/     # Orchestrator + 提取/分类
  src/lib/llm/       # Provider Adapter（mock / openai-compatible）
  src/lib/data/      # Repository（demo / supabase）
  src/lib/security/  # URL 抓取防护
  src/features/      # 各模块页面
  src/demo/          # Demo 种子数据
supabase/migrations/ # 数据库 Migration（含 RLS）
docs/                # 工程文档（PRODUCT_SPEC / ARCHITECTURE / ...）
project.md           # 长期项目状态文档（实时更新）
```

## 工程文档

见 `docs/`：PRODUCT_SPEC、ARCHITECTURE、BUSINESS_WORKFLOW、AGENT_DESIGN、DATABASE_DESIGN、SECURITY、TEST_PLAN、DEVELOPMENT_PLAN。

## 团队

三人异地协作（Member A 架构/安全 · Member B 前端/交互 · Member C 数据工程），通过 GitHub Issues / Branch / PR / Review 协作。

## 许可

待定（参赛期间暂不开放复用）。