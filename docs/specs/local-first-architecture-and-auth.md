# CampusMate 本地优先架构与认证方案（2026-11-19）

> 方向修正：CampusMate 定位为**本地运行的 Web Agent**（类似 DeepSeek Harness / Hermes 的开源形态）：
> 用户在自己机器上启动一个本地进程，浏览器打开 `http://127.0.0.1:<port>` 使用；账号、会话、工作区、
> 文档、密钥全部留在本机；不依赖云端服务即可完整运行。云端能力（Supabase/Qoder Sites）降级为**可选插件**
> （云同步、公开 Demo），不再作为运行前提。这与 Codex/Cursor 的"服务器托管 agent"模式不同。

## 1. 现状与冲突

- 当前前端认证与数据依赖 Supabase：`web/src/app/auth.tsx`（邮箱注册/登录）、`lib/data/supabase.ts`、
  `VITE_SUPABASE_URL/ANON_KEY`；后端 `api/jwt.ts` 校验 **Supabase JWT**（`verifySupabaseJwt`），
  所有 `/v1` 端点以 `sub` 作为 userId。
- 后端已有可本地运行的基础：Node HTTP API + Worker + **PGlite 嵌入式 Postgres** + 本地 artifact 存储 +
  Playwright 文档沙箱；只差本地认证与前端数据层切换。
- 已确认可用的成熟组件（MIT/Apache）：**better-auth 1.7.26**（本地会话/邮箱密码/passkey/OAuth provider）、
  `@better-auth/passkey`、`@modelcontextprotocol/sdk 1.32.2`（MCP 客户端）、zod（已有）、OpenTelemetry、
  Playwright/promptfoo（测试）。目前项目**尚未使用 better-auth**（用户询问确认）。
- 比赛/仓库中未发现 Qoder 的 OAuth/OIDC 接入资料（client_id/secret、authorize/token/userinfo 端点、
  回调白名单）；需要用户提供或确认接入方式。

## 2. 目标架构（本地优先）

```
本机（单进程可展开为 backend + worker）
┌──────────────────────────────────────────────────────────────┐
│ HTTP API  /v1/*（任务/会话/工作区/文档/审批/MCP/技能）           │
│ Auth      /api/auth/*（better-auth：本地会话 cookie）           │
│ Worker    lease/检查点/恢复（已有）                             │
│ DB        嵌入式 PGlite（app 数据 + auth 表 + settings + 审计）  │
│ FS        本地工作区 + artifacts 存储（已有）                    │
│ Agent     事件日志/上下文工程/工具执行（已有）                   │
│ MCP client/skills（新增）                                       │
└──────────────────────────────────────────────────────────────┘
          ▲ 浏览器 http://127.0.0.1:5173 或打包后的本地静态页面
          │  默认只绑定 127.0.0.1；无云端依赖
可选插件：云同步（Supabase/自建）、公开 Demo（Qoder Sites 静态前端 + 可选远程后端）、Qoder SSO（OIDC）
```

### 认证设计（better-auth + 可插拔 Qoder SSO）

- better-auth 挂载在本地后端 `/api/auth/*`，会话 cookie（SameSite=Lax、HttpOnly、Secure 仅在 HTTPS）。
- 登录方式：
  1. **本地账号**：邮箱+密码（默认可用）；
  2. **Passkey**（可选插件）：本机生物识别/安全密钥，无密码；
  3. **Qoder SSO**：通过 better-auth 的 generic OAuth 插件接入 Qoder OIDC（若官方提供凭据）；
     未配置时该按钮隐藏（不出现死入口）；
  4. **匿名本地模式**（单机单用户，默认）：首次启动生成稳定的本机用户身份并自动登录，
     可在设置中升级为真实账号（用于云同步/多账号）。
- 后端鉴权：把现有 `verifySupabaseJwt` 抽成 `AuthAdapter` 接口；本地模式用 `auth.api.getSession({ headers })`，
  云模式保留 Supabase JWT 适配器。`userId` 继续用于所有 owner 隔离，**不改数据访问层语义**。
- 数据库：auth/session/settings 表与 app 数据同库（PGlite），通过 Kysely adapter 接入 better-auth
  （若 PGlite adapter 不满足，退化为本地 SQLite 仅存 auth 表并在 PGlite 存 userId 映射；不建第二个"业务"数据库）。
- 安全：默认 `127.0.0.1` 绑定；本地 API 仅接受同源 + 本地 token；旧 `X-Session-Owner` dev 路径移除或禁用于生产；
  API Key 继续服务端加密（已有 AES-256-GCM），不进入前端。

### 数据与缺失项补齐（与本地化一起做）

1. `settings` 表 + `/v1/settings/{agent,model}`（工作步骤、默认模型/思考、权限默认、语言）。
2. auth 相关表（better-auth 迁移）：user/session/account/verification/passkey。
3. 会话级事件流与工作步骤事件补强（思考摘要、计划、终端输出、工具参数预览）。
4. 工作区文件 HTTP API + artifact 预览（侧边栏文件树/预览依赖）。
5. multipart 附件服务（替换 4 张 base64；本地文件存储 + 清理策略）。
6. MCP servers 表 + `/v1/mcp/servers` CRUD；技能注册表 + `/v1/skills`（启停/删除/查看 SKILL.md）。
7. 权限默认值与云端/本地一致性；审计事件表（登录、审批、工具风险操作）。

### 分阶段实施

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| A | 抽 `AuthAdapter`；接入 better-auth（邮箱密码+匿名本地模式）；后端 `/api/auth/*`；前端登录页改为本地认证；移除运行必需 Supabase | 无（可立即做） |
| B | 本地数据层切换：前端 repository 走本地 `/v1`；settings 表与 API；会话/事件/工作区 API 补齐 | A |
| C | passkey；Qoder OIDC（有凭据后）；可选云同步适配器（Supabase 保留为插件） | Qoder 凭据/云方案 |
| D | MCP 客户端与管理页、技能注册表与管理页；附件 multipart；侧边栏文件树/预览 | B |
| E | 本地打包（单命令启动/托盘可选）、备份/迁移、OTel、视觉精修 | A-D |

## 3. 需要确认的问题（阻塞性）

1. **Qoder 登录**是否有官方 OAuth/OIDC 接入资料（authorize/token/userinfo、client_id/secret、回调地址限制）？
   还是希望"复用本机已登录的 Qoder 账号/本地 token"？或先做本地账号 + 预留 Qoder SSO 配置？
2. **Supabase 去留**：是否彻底移出运行时（本地 PGlite 唯一数据源，Supabase 仅可选云同步），
   旧 Supabase 数据是否需要迁移/导出导入？
3. **运行形态**：单机单用户匿名默认（最像 DSH/Hermes），还是单机多本地账号（需要登录隔离）？
   是否需要"本机启动 + 局域网/远程访问"模式（会引入额外认证安全要求）？
4. **比赛交付形态**：Qoder Sites 公开 Demo 与"本地优先"如何取舍（本地版为主 + Demo 版静态前端 + 可选后端；
   或仅提交本地运行说明/录屏）？
5. 是否同意引入这些成熟组件：better-auth(+passkey)、MCP TS SDK、Kysely（auth adapter）、OpenTelemetry、
   promptfoo（评测）？（均为 MIT/Apache，已确认版本可用）

## 4. 建议的默认选择（若用户无特别要求）

- **认证**：本地账号（邮箱+密码）+ 匿名本地模式默认 + passkey 可选；Qoder SSO 作为可配置 OIDC provider 预留。
- **数据**：本地 PGlite 单一数据源；Supabase 降级为可选云同步插件；不做旧数据自动迁移，提供导出/导入脚本。
- **形态**：单机单用户默认；保留多本地账号能力；默认只绑定 127.0.0.1。
- **交付**：本地运行包为主，Qoder Sites 仅托管静态 Demo（不依赖云端 agent 服务）。
