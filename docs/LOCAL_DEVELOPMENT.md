# 三人远程开发：每人一套本地 Docker 环境

适用当前阶段：三位成员只有各自电脑，没有共享服务器。每人拉取相同代码/迁移、启动独立的本地数据库；**不会自动共享各自的数据**。以后需要共同联调数据时再单独部署共享测试环境，不把成员电脑的 Postgres 暴露公网。

## 为什么不是单独起 Postgres

### 核验保存更新 · 2026-11-14

`npm run db:start` 现在追加第 5 份规范迁移（生成版本 20261114000300，对应 `supabase/migrations/0003_atomic_verification_reports.sql`），只新增原子 RPC，不回改已应用文件、不 reset 或清库。运行 `npm run db:verify-reports` 可用随机临时机会/报告/账号验证真实 SQL 回滚、重试、并发幂等及原权限拒绝，结束后清理本次 fixture。公共核验报告原来是服务端授权写入，仍保持该边界；普通登录者没有全局写权限时会明确失败，不再假称保存成功，也不为修功能直接开放全局 INSERT。没有迁移时前端明确报接口未就绪，不回退到两次非原子 INSERT。

当前前端依赖 Supabase Auth 和 REST/RLS。只启动 Postgres 不能让注册登录、Repository 和账号隔离自动可用。本项目用固定版本 Supabase CLI 管理 Docker 的 DB + Auth + REST + Kong；Studio、Storage、Realtime、邮件箱和 Edge Runtime 默认关闭，减少资源消耗。模型仍由现有 8787 代理提供，模型配置保持独立。

## 首次启动

先启动 Docker Desktop，使用项目要求的 Node 24。在仓库根目录执行：

```powershell
npm ci
npm --prefix web ci
npm --prefix backend ci
npm run db:start
npm run db:verify
npm run db:env

cd web
npm run dev -- --port 5173 --strictPort
```

如果前端已启动，在 `db:env` 后正常停止并重新启动 Vite，使本地配置生效。

- 网页：`http://127.0.0.1:5173/app`
- 注册/登录：`http://127.0.0.1:5173/login`
- 本地 Auth/REST：`http://127.0.0.1:56421`
- 本地 SQL：`127.0.0.1:56422`（不是其他项目占用的 5432）

仅本地开发关闭邮箱确认，注册后可直接登录。没有替你创建个人账号，验证脚本只用随机测试账号并在结束后清理。

## 已有 Demo 数据不会清空

配置数据库后，未登录仍可使用原浏览器的 Demo 数据。登录本地账号后使用该账号的独立数据库数据，初始为空是正常的；退出后回到 Demo。不会自动把虚拟档案/示例机会写进真实账号，也不会自动迁移你旧浏览器的内容。换浏览器不迁移 Demo；如需迁移，应先导出备份并确认归属。

当前 `VITE_BACKEND_URL` 保持空值，避免把尚未全部持久化的 Runtime 当成完整生产后端开启。**这一阶段接通的是登录、业务 SQL/REST 和账号隔离；API/Worker 其他内存 Store、统一工具审批仍是后续任务。** 聊天继续使用已配置的模型代理；不能因为有 DB 就宣称全部 Agent 记忆已落库。

## 停止与日常启动

```powershell
# 仓库根目录
npm run db:status       # 只显示地址/状态，不输出密钥
npm run db:stop         # 只停 CampusMate，保留数据，不停其他项目
npm run db:start        # 复用已有数据与镜像
```

没有提供自动 reset/删除卷脚本。不要为了解决启动错误执行 `docker system prune`、`docker compose down -v` 或 `supabase db reset`。这些操作不是日常重启。

验证持久化（仅随机测试用户）：

```powershell
npm run db:verify -- prepare
npm run db:stop
npm run db:start
npm run db:verify -- resume
```

脚本验证真实本地登录、注册建档触发器、本人读写、跨账号不可读写、伪造 owner 被 RLS 拒绝、未登录不可读，以及重启后记录仍在。不会连接云端，不请求付费模型，不读取 QQ 数据。

## Git、迁移与团队约定

- 根目录 `package.json/package-lock.json` 固定 Supabase CLI 版本；`supabase/config.toml` 固定项目与端口。
- 既有 SQL 源文件保持在 `supabase/migrations` 和 `backend/migrations`；启动脚本按明确顺序复制到被忽略的 `.local/dev/supabase/migrations` 并使用不重复版本号，避免两个 `0002` 冲突。没有向云端 link/push，没有重置库。
- `.local/dev/migration-hashes.json` 检测旧迁移内容变动；已使用迁移不要回改，应追加新版本并更新启动清单。
- `.local/`、`web/.env.development.local`、数据库连接串、CLI 缓存、私钥与本机模型配置全部忽略；不要发到群里或提交 Git。
- 三位成员应通过审核后的提交/分支/PR 同步，不能依赖某个人未提交的工作区。当前工作区的历史修复需要单独审阅后提交；本次不自动 push。
- 其他容器和数据卷不复用、不停止、不删除。专用网络默认回环绑定，脚本还会检查实际 HostIp；若 Docker 未遵守回环绑定就停下本项目，不能假装安全启动成功。

Windows Docker Desktop 实测会忽略 bridge 的默认绑定选项，因此启动器为 Supabase 子进程单独使用 Docker 参数代理，显式添加 `127.0.0.1`。不修改系统 PATH、Docker 全局设置或其他项目。Windows 使用系统 .NET Framework C# 编译器生成忽略目录内的转发器；若该组件缺失会明确失败，不降级为开放端口。Linux/macOS 使用 Node 转发器，尚待其他成员在各自系统复验。

## 本机验收记录 · 2026-11-14

- 四个容器 DB/Auth/REST/Kong 已运行；实际发布地址仅为 `127.0.0.1:56421` 和 `127.0.0.1:56422`。四份迁移已在本地真实 PostgreSQL 应用，不是只跑 PGlite。
- `db:verify -- prepare` → `db:stop` → `db:start` → `db:verify -- resume` 通过：真实注册、登录、建档、私有待办读写、跨用户 RLS、伪造 owner 拒绝、未登录不可读、停启保留数据，以及 Runtime 同会话 SQL 历史与隔离。随机测试账号/数据已清理。
- 使用两套独立 Chrome 浏览器上下文验证当前 5173 页面：A 登录后读取真实待办、勾选完成、刷新保持；B 登录后看不到 A 的待办。没有触碰用户正在使用的浏览器数据。未请求付费模型、未读取 QQ。
- 已生成被忽略的前端开发配置并重启网页，`/login` 可以使用本地账号；未登录仍为原 Demo，未自动导入旧数据。后续工作边界见上文 Runtime 说明，不代表全部后台 Store 已持久化。

官方参考：[本地开发 CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)、[start 参数](https://supabase.com/docs/reference/cli/supabase-start)。首次启动会下载镜像；镜像下载完成不等于注册/数据库验收通过。
