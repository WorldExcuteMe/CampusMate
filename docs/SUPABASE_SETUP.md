# CampusMate · Supabase 设置指南（跟做版）

> **当前三人各自电脑开发**：先使用 [LOCAL_DEVELOPMENT](LOCAL_DEVELOPMENT.md) 的 Docker 本地环境；不必先配置云端项目。以下步骤留给后续共享测试/部署，不能把原开发者云项目地址当作你们当前已接入的数据库。

目标：把 Demo 模式切换为真实多用户模式。Supabase 是**集中式后端，团队配置一次，学生零配置**（注册/登录即用，RLS 按用户隔离）。

代码侧已就绪：`src/app/auth.tsx`（登录/注册/会话）、`src/lib/data/supabase.ts`（SupabaseRepository）、`supabase/migrations/0001_init.sql`（14 表+RLS）与 `0002_profiles_and_provenance.sql`（建档/来源标记）。你只需完成下面的云端配置。

---

## 步骤 1 · 创建项目
1. 打开 https://supabase.com/dashboard → 登录 → 进入你的组织（`1602684362@qq.com's Org`）。
2. **New project** → 名称 `campusmate` → Region 选 `ap-southeast-1`（新加坡，国内访问较近）→ 设置数据库密码（保存好）→ Create。
3. 等待 1–2 分钟初始化完成。

## 步骤 2 · 取连接信息（公开值）
- **Project URL**：`https://zzmxndiofaulsalrvhqm.supabase.co`（原环境项目记录，本机克隆不带 `.env`；注意去掉 `/rest/v1/` 后缀）。
- **anon / publishable key**：dashboard → 项目 → **Settings → API Keys** → 复制 **Publishable key**（`sb_publishable_…`）。supabase-js 可直接用它作 `VITE_SUPABASE_ANON_KEY`。旧版界面在 Settings → Data API → Project API keys → `anon public`。
- ⚠️ **service_role / secret key** 是服务端密钥，**绝不**放进前端或 `VITE_` 变量。

> 网络说明（原开发者环境历史记录，非本机复验）：`supabase.co` 直连被重置，需代理 `127.0.0.1:7890`；远程 MCP（mcp.supabase.com）与 6543 池化端口在本机自动化通道不可用。**dashboard 在浏览器可正常访问**，故密钥复制与 SQL 执行走 dashboard 最稳。`web/dev/apply-migration.mjs` 是原环境的备用脚本，依赖与连接参数未在本机复验；本次不使用它执行迁移。

## 步骤 3 · 建表 + RLS（跑 Migration）
- 方式 A（dashboard）：新项目依次执行 `0001_init.sql`、`0002_profiles_and_provenance.sql`、`0003_atomic_verification_reports.sql`；已有项目只追加尚未应用的迁移。不要重跑 0001 的 CREATE POLICY。0003 提供原子保存 RPC，不修改旧数据或放宽 RLS；公共核验报告仍只允许已有授权服务端写入，不能把 service_role 放进前端。
- 方式 B（MCP）：让 Agent 用 `apply_migration` 执行同一文件。
- 验证：Table Editor 应看到 profiles / inbox_items / opportunities / tasks / verification_reports / evidence_items / agent_runs 等 14 表。

## 步骤 4 · 配置认证
- Authentication → Providers → **Email** 启用。
- 演示期可关闭 **Confirm email**（Authentication → Providers → Email → 关闭确认），注册即可登录；正式运营再开启。
- 无需第三方 OAuth（可选后续加 GitHub/Google）。

## 步骤 5 · 写前端环境变量
在 `web/.env`（新建，勿用 `.env.local` 的密钥文件）：
```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon/publishable key>
```
重启 `npm run dev`。配置 URL+key 后可从 /login 登录真实模式；未登录仍可体验 Demo。数据按 `auth.uid()` 隔离，查询缓存按会话主体重建。

## 步骤 6 · 验证隔离
- 用两个邮箱注册 A/B，各自导入通知/建任务；A 看不到 B 的数据（RLS）。
- 未登录访问 /app 为 Demo，不读写真实用户数据。
- 新注册用户应有 profiles 行；打开画像页不应报缺行错误。
- A → B → 退出登录，界面不应保留上一账号缓存。
- 本次本机没有云端凭据；以上真实数据库验收尚未执行。

## 步骤 7 · 部署到 Sites
- 构建时注入 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`（公开值）。
- 模型密钥放服务端 Sites Function Secret，**不进前端**。当前已实现 Sites Function，完整接线见 [AI_BACKEND_SETUP](AI_BACKEND_SETUP.md)；不能仅发布静态 dist。
- 发布与公开访问需用户确认（见 project.md）。

---

## 常见问题
- **仍显示 Demo**：`.env` 未生效→重启 dev；或 URL/key 为空。
- **登录报 invalid**：步骤 4 未启用 Email，或密码<6 位。
- **表不存在**：步骤 3 未跑 Migration。
- **RLS 拒绝**：正常——未登录或跨用户访问被拦截；用本人会话操作。

## 密钥安全清单
- 前端只含 anon/publishable（公开）。
- service_role / DeepSeek key 仅服务端（.env.local gitignored / Edge Function secret）。
- `.env*`、`.providers.local.json` 均已 gitignore，不上传 GitHub。
