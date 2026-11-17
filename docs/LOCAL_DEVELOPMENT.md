# 三人远程开发：每人一套本地 Docker 环境

适用当前阶段：三位成员只有各自电脑，没有共享服务器。每人拉取相同代码/迁移、启动独立的本地数据库；**不会自动共享各自的数据**。以后需要共同联调数据时再单独部署共享测试环境，不把成员电脑的 Postgres 暴露公网。

## 为什么不是单独起 Postgres

### 集成更新 · 2026-11-15

本地迁移同步使用 `backend/src/runtime/migrations.ts` 的完整清单，保留已有迁移的生成版本名；不会自动重置旧库。下述 11 月 14 日记录描述当时的五份基线。

### 同会话多标签草稿冲突更新 · 2026-11-15

浏览器草稿库加性升级至v2，旧稿可按后端会话ID迁移，避免两个本地别名被误当成不同会话。保存使用同一IndexedDB事务中的版本比较与写入；BroadcastChannel、storage及窗口聚焦仅负责通知，漏通知也不能绕过版本检查。冲突时主稿不覆盖，本页文字、附件和解析中File另存独立分支；页面显示两份预览，选择后仍可从“保留的草稿版本”恢复另一份，刷新不丢冲突副本。

正常发送、名称提交也先原子校验并保留操作前备份；冲突未处理前禁止发送。删除写入墓碑并清理该会话保留版本，旧页不能复活。保留版本仅在当前浏览器、当前账号下可见，直到会话删除，不上传云端。升级后请刷新旧标签页以启用新版界面；存储异常仍明确提示并保留内存内容。

运行 `npm run test:draft-tabs`：同一个浏览器上下文中的两个真实标签页共享IndexedDB/Auth，刻意丢通知、制造并发，验证原子CAS、保留/恢复文本与附件、刷新、删除墓碑、账号隔离及v1迁移。脚本只使用新临时账号，拦截模型提交，不调用付费模型；结束清理临时账号。

### 会话草稿隔离更新 · 2026-11-15

未发送的文字、附件（含解析中的原始File）与名称编辑按账号+会话保存在当前浏览器 IndexedDB，不上传聊天同步或模型，不跨设备恢复。切换/刷新保留独立草稿；异步附件只写回原会话，移除或删除后不会被迟到解析复活。解析失败明确提示，未完成附件不能发送。新消息发送只清空本会话输入，编辑重发/重试旧轮次不吞掉新草稿。

本地存储失败明确警告，当前内容仍在内存但不保证刷新恢复；写入未完成时刷新/关闭会触发浏览器离开提醒。有草稿的空会话不会被后台同步自动切走，最近活动会话也按账号保留。删除会话同时清理本机草稿，不保留可用于继续发送的附件。

`npm run test:composer-drafts` 在运行中的本地服务上，用两个临时账号验证真实IndexedDB、跨会话/账号、刷新、图片/文档附件、延迟解析、重命名与旧轮次重试。测试拦截所有模型任务提交，不调用付费模型，结束后清理本次临时账号。

### 工具重试与检索质量更新 · 2026-11-15

机会未知截止日期支持 `null`、省略或空字符串；非法实际日期仍拒绝保存。同一操作的真实成功重试可以解除已确认的先前失败，但不同目标、不同导出格式、不确定副作用、缺失原始记录的旧错误不能被抹掉。进度保留原始失败并标注后续恢复，模型可达与工具完成分别验收。旧任务审计不自动改写，也不自动重放已执行操作。

检索检查 HTTP 状态、解析及完整主题关键词匹配；明显无关条目会被过滤，质量不足明确提示，不等于模型断线。搜索命中只是线索，仍需打开官网正文核实。上游搜索可能波动，不能保证每次都有相关结果；可改用具体名称、英文名或 `site:` 限定来源。

`npm run test:tool-recovery` 需运行本地数据库、API和前端，用临时账号、隔离的脚本模型验证真实 SQL/API/UI 的恢复状态及错误保留，不调用付费模型、不认领共享队列中的现有任务，结束后清理本次账号。

### 文档导出环境更新 · 2026-11-15

在仓库根目录运行 `npm run documents:setup` 安装与后端锁定 Playwright 匹配的 Chromium，再运行 `npm run documents:check`。自检真实导出并复读中文、表格、图表的 Word/PDF，不调用模型，不操作用户数据。`npm ci` 不会自动下载浏览器，三位成员各自在运行后端的电脑执行；Linux 系统库安装见 `backend/README.md`。

产品与自检使用相同的固定 Chromium channel、保留浏览器沙箱，不再检测完整 Chromium 却尝试启动独立 headless-shell。缺资源或启动失败明确报错，不标成导出成功；修改后需重启运行中的后端。

本地 Docker、API/Worker（8788）和前端（5173）都运行时，可执行 `npm run test:document-export`：用随机临时账号验证真实 API、网页按钮下载、文件哈希/中文复读、重复导出缓存及跨账号隔离，结果保存在忽略目录 `.local/dev/document-live/`。脚本不请求模型，不操作现有账号，结束后清理本次账号和数据库测试记录。

### 会话同步更新 · 2026-11-15

追加 `20261115110000_campusmate_session_management.sql`（仅新增元数据、软删除标记、版本号和只读历史导入字段），运行 `npm run db:start` 后重启后端。登录后会从同一后端恢复完整会话，5秒轮询及窗口重新聚焦会刷新；名称、模式、归档/恢复和删除同步到数据库。删除是保留审计记录的软删除，有未结束任务时须先完成或取消。版本冲突明确提示，不允许旧窗口覆盖新修改或复活删除项。

首次升级会先保留 `campusmate.sessions.before-cloud.v1:<owner>` 本地备份，再导入尚未落库的旧消息；旧消息只显示，不重放工具、不进入Agent执行上下文。Demo不上传，账号切换请求绑定预期owner，接口失败会保留本地缓存并提供重试。连接不同本地数据库的三台电脑不会因此自动共享数据。

验证：`npm run test:session-sync` 需要本地完整服务及Chrome，创建一个随机临时账号，在两个独立浏览器上下文验证恢复、重命名、归档/恢复、模式和删除同步，结束后清理fixture；不调用付费模型。

### Agent 业务工具更新 · 2026-11-15

新增 `20261115090000_campusmate_business_tools.sql`，只为通知增加 `merged_from` 引用，不删除数据、不放宽 RLS。运行 `npm run db:start` 应用，再重启 Runtime/Worker；无需重新执行 `db:env` 或清库。

可运行 `npm run db:verify-business`，用随机临时账号验证真实 Docker SQL、REST 可见性、双账号隔离、并发幂等、目标原子回滚和合并引用。脚本不调用付费模型，结束后清理本次临时账号及其数据，不操作现有账号。

配置 Postgres 的 Runtime 现支持 `save_to_inbox`、`create_daily_task`、`set_growth_goal`、`merge_inbox`，写入与前端 Repository 相同的通知、待办、目标和画像表。服务端仅使用已认证任务的 owner；重复创建按内容与 owner 幂等；成长目标三处写入与通知合并各自使用事务。重复通知仅归档、保留原文及引用，冲突日期/年度/轮次不合并。未配置 Postgres、参数错误或写库失败明确返回失败，不退回内存冒充持久化成功。没有接入 QQ/微信本机能力时，仍不能自动读取群消息。

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

`db:env` 只配置本地登录、SQL/REST，默认保留空的 `VITE_BACKEND_URL`，不会替你启动 API/Worker。当前代码已实现 Runtime 持久化、审批、会话及加密 BYOK；需要按 `backend/README.md`、`docs/MODEL_SETUP.md` 配置并启动后端，再显式设置 `VITE_BACKEND_URL=http://127.0.0.1:8788` 并重启 Vite。空值仍走兼容的浏览器聊天路径，不能据此验收后端恢复或加密 BYOK。Docker/Auth/REST 的真实联调须在各成员本机执行，本次集成只验证组合迁移和受控 HTTP 测试夹具。

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
