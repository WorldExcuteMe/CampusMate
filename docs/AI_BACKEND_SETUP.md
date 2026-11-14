# AI 后端接线与修复说明 · 2026-11-13

## 当前实现边界

- 业务数据仍唯一存放在 Supabase；没有引入第二套数据库。
- `web/functions/handler.ts` 是本地代理与生产 Deno Function 共用的 HTTP handler。
- 正式部署入口：`web/functions/index.ts`；函数目录为整个 `web/functions/`，前端目录为 `web/dist/`，SPA 回退开启。**只有发布静态 dist，真实 AI 不会工作**。
- 前端生产默认调用同源 `/functions/v1/app/providers` 与 `/functions/v1/app/llm`，开发默认 `/api/providers` 与 `/api/llm`（同一 handler）；Vite dev/preview 只在本地将其代理到 `127.0.0.1:8787`，这不是生产路由。
- 当前实现的是 Sites Function，不是已经部署的 Supabase Edge Function。未执行云端部署、迁移、真实密钥配置或付费模型调用。
- 生产需要 Supabase 登录；未登录用户仍可用本地 Demo + 明确标识的 Mock，不开放匿名付费模型调用。

## 1. 数据库升级（先做）

已有 0001 的环境，仅执行 `supabase/migrations/0002_profiles_and_provenance.sql`。
新项目按顺序执行 0001、0002；不要重复执行 0001 的 CREATE POLICY。
0002 增加首次注册建档触发器、历史用户画像回填、提取 Mock 标记与运行记录 provider/is_mock，不删除业务数据。
客户端也有首次读取画像的并发安全兜底，不会覆盖已有资料。

迁移文件已经写好，但本次没有连接云端执行；真实数据库的迁移和 RLS 双账号验证仍待配置后验收。

## 2. 本地运行

在 web 目录运行（代理会由监督启动器自动启动）：

```powershell
npm ci
npm run dev
```

需要独立调试代理时可用 `npm run dev:api`，先确认没有同端口服务；不必再开第二个代理。

没有模型密钥时，Inbox 明确回退到 Mock。要用真实模型，在 gitignored 的 `web/.env.local` 配置：

```dotenv
LLM_API_KEY=<仅服务端模型密钥>
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
LLM_DISPLAY_NAME=DeepSeek
```

修改该文件后重启代理。也可通过设置页添加 OpenAI 兼容供应商，密钥保存在 gitignored 的 `.providers.local.json`。
本地代理只绑定 loopback，拒绝跨站请求及非 loopback Host，不得暴露为公网服务。
目前不支持 Anthropic 原生协议；不再提供实际无效的协议选项。

## 3. 生产 Function 配置

部署平台必须支持运行 Deno Function，并将 `/functions/v1/app/*` 路由给该入口。
仅支持静态托管的平台需要另配兼容 API；不能靠 Vite proxy 代替生产服务。
服务端 Secret 必须配置：

| 名称 | 内容 |
|---|---|
| SUPABASE_URL | 与前端相同的 Supabase 项目 URL |
| SUPABASE_ANON_KEY | 公开 anon/publishable key，用于服务端向 Auth 校验用户 |
| LLM_API_KEY | 模型密钥，不能放进 VITE_* |
| LLM_BASE_URL | HTTPS OpenAI 兼容 API 根地址，如包含 /v1，保留该段 |
| LLM_MODEL | 模型名 |
| LLM_DISPLAY_NAME | 可选显示名称 |
| AI_ALLOWED_ORIGINS | 可选，跨源前端 Origin 白名单，逗号分隔；同源无需配置 |

浏览器只提交自己的 Supabase access token；服务器调用 `/auth/v1/user` 验证身份，不信任浏览器传入 userId 或自行解码的 JWT。
生产供应商管理只读，由管理员配置 Secret；不实现公共访客修改全局密钥，也未实现用户自带密钥的云端持久化。

防护：256KB 请求上限、30 秒模型超时、固定服务端模型、2048 输出 token 上限、每用户每实例 20 次/分钟、错误脱敏、拒绝模型请求重定向。
限流为**单实例尽力限制**，不是跨实例全局预算；公开上线前仍需网关/集中式额度控制和真实集成验收。

## 4. 验证

```powershell
npm run test
npm run build
npm run check:function
npx playwright install chromium
npm run test:e2e
```

已有 Chrome 可设置 `$env:PLAYWRIGHT_CHANNEL='chrome'` 后运行 E2E。
Function 检查使用固定版本 Deno 2.9.6（npx 临时运行）；本地生产鉴权入口也可使用已安装的 Deno 执行 `npm run dev:function`。
Vitest 覆盖 ID、画像初始化、会话/缓存隔离、代理鉴权与工具透传、Mock 来源及工具循环；HTTP/模型测试使用 fixture，不消耗真实模型额度。
Playwright 截图使用每项测试的输出目录，不再写死开发者用户名；`web/test-results/` 已 gitignore。

## 2026-11-14 上游 Runtime

上游另增 `backend/` 的 Task API/Worker，启用需 VITE_BACKEND_URL 与真实 Supabase 会话。默认无凭据 Demo 不启用该路径。当前非 TaskStore 的状态仍为内存，生产拆分限制见 SYNC_REVIEW_2026-11-14.md，不能仅配置 DATABASE_URL 就宣称全状态持久化。
