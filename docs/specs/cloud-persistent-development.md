# 现有云端 Supabase 持久化接入

2026-11-15；用户在 5176 保存模型遇到 Failed to fetch，随后明确要求配置数据库。用户因 WSL 内存占用选择“复用现有云端 Supabase”，本规格取代之前本地容器方案（初始方案已留存在 v15 快照），不再部署本地数据库栈。单代理，spec-tdd-workflow；原始源码 d22efc9，配置先经 workspace-backup 保存。用户已授权配置既有项目，不创建新项目、付费分支或重置密码。

## 已复现与实测

- 5176 的 VITE_BACKEND_URL 指向 8788，而后端未启动；先已恢复本机内存后端并补加密主密钥，仍需持久化。
- 既有云项目为 zzmxndiofaulsalrvhqm；数据库密码已在项目私有配置中，未输出或要求用户在聊天重发。
- Node 直连 IPv6 数据库及 HTTP 均出现 ECONNRESET；Windows 系统代理可达。通过现有 loopback HTTP CONNECT 代理，Postgres SSLRequest 返回 S。
- 官方控制台证书 https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt；证书/主机名校验保持开启后，已用既有密码完成只读 SQL 连接。当前 public 有 15 个旧业务表，缺新版 agent_tasks/会话/供应商等表；无 supabase_migrations.schema_migrations 历史。

## 目标与边界

Windows API/Worker 连接现有云 Postgres，5176 保留原云端 Auth/REST 及账号。复用九份显式迁移和七类 Postgres Repository；任务、会话、加密供应商、文件等跨进程重启保存。增加显式数据库代理与可信 CA 配置；不关闭证书或主机名验证。主密钥保持既有值，API key 不写前端、日志或 Git。

云端写入前：在可重复读只读事务中保存相关 public 表数据、schema/权限/触发器定义的加密备份及计数，核对目标项目和迁移影响。既有行不删除、不清库、不修改现有密码，不覆盖其他项目。只补现有项目需要的 schema；有不兼容或破坏性迁移时先停在具体可审查 SQL。测试数据采用独立随机 IDs，不能让夹具触发真实 LLM 调用。

WSL 只完成了工具检查/依赖安装；没有启动 CampusMate 数据库容器。日常 Agent 不依赖 WSL，不停止用户其他 WSL 服务，不修改全局代理或 WSL 配置。源码改动仅本地提交，本次不自动 push/PR/main 合并。

## GWT

| ID | Given / When | Then | 保持不变 / 验证 |
| --- | --- | --- | --- |
| C1 | 显式 PG 代理、代理拒绝/超时 | 成功转接或有界失败，不能直连降级泄漏凭证 | 本机假代理测试；先观测原实现忽略代理的红灯 |
| C2 | 云 DB 私有 CA | TLS 验证通过；错误 CA/主机名失败，不能自动跳过 | 官方 CA 的真实云只读 SQL 连接；配置回归 |
| C3 | 旧 15 表及现有数据，应用迁移 | 只补齐运行 schema，既有数据计数不减少，迁移重复安全 | 加密备份/前后计数、组合迁移和真实 SQL |
| C4 | 随机 owner 的虚构 provider key/会话/暂停任务 | API→Postgres，列表无明文、其他 owner 不可读 | HTTP+SQL；不向 AMD 发送诊断 key |
| C5 | 停 Worker 执行再重启 API | 记录同 ID/内容仍可读，随后只清理本次测试数据 | 实际进程重启、读回；启用正式 Worker 前无夹具排队任务 |
| C6 | 当前用户登录 5176 设置页 | 加载和保存成功，不再 Failed to fetch | CORS、认证拒绝、实际浏览器/用户会话验证 |
| C7 | 下次启动与内存约束 | 可复现的 Windows 启动入口，云数据/主密钥保留 | 启动说明；无需常驻 WSL |

## 影响面

现有 backend/src/runtime/sql.ts: PgPool 的代理/SSL options；backend/src/app-context.ts: 环境配置接线；新增 db-proxy 传输与回归。backend/.env.example 和文档说明新增显式字段；私有 backend/.env 绑定连接串、代理及 CA。前端 Auth/数据源保持当前云项目；不重写业务层。必要时修复迁移脚本仅执行旧 0002 的缺口，复用 runtime/migrations.ts 清单。

## 顺序、回滚、验证

先代理红→绿及类型检查 → 云端加密备份/旧 schema 差异 → 事务性现有迁移 → SQL/HTTP owner/保存及重启验证 → 完整后端回归、相关前端检查 → 运行说明与本地 scoped commit。闸门串行。

失败时保留备份与诊断，恢复已知配置/进程；不以删除云数据或重置密码修复。新增 schema 可保留，数据恢复须基于备份审查而非自动 DROP。尚未实际验证的云 RLS、真实模型及写作/KV 收益分别标注，不能由 PGlite 替代。

## 官方依据（2026-11-15）

- https://supabase.com/docs/guides/database/connecting-to-postgres ：常驻后端直连或 session pooler；服务端 CA 配置和 verify-full。
- https://supabase.com/docs/guides/platform/ssl-enforcement ：控制台提供 Supabase CA，不能把仅加密当作验证。
- https://nodejs.org/docs/latest-v24.x/api/http.html#event-connect ：HTTP CONNECT 的 socket/head 转接。
- 本机 pg 8.23.1 的 Connection/ClientConfig 提供 stream 工厂，TLS 在其上与原数据库主机完成。

## 实施与验收结果

- C1：先红后绿；显式 CONNECT 拒绝不直连降级、合包字节及后续双工、超时、显式 CA/URI 冲突共 4 项通过。后端类型检查通过；完整后端 293 项，292 pass / 0 fail / 1 外部 TEST_DATABASE_URL skip。
- C2：通过 Windows 原生代理完成官方 CA 的云 SQL 连接，TLS 证书/主机名验证开启。同一通道以错误 CA/主机身份验证，分别按 SELF_SIGNED_CERT_IN_CHAIN / ERR_TLS_CERT_ALTNAME_INVALID 拒绝。
- C3：已加密备份并解密读回；旧 schema 核对后登记基线，再事务性应用其余 8 份现有迁移。原资料未变、九条原生历史可追踪；再次运行 applied=[]。
- C4/C5：真实云 API 保存虚构供应商及默认项、会话、消息、排队任务和文件；实际 API 进程重启后同 ID/内容读回，密钥解密通过。API 跨 owner 拒绝，实际 authenticated 角色 RLS 隔离通过，36 个 public 表 RLS 开启；测试用户全部清理，Worker 恢复运行，未发生模型调用。
- C6：CORS preflight 204、无认证 401、夹具认证写入/读回通过。浏览器当前处于 Demo，模型设置正确要求登录；未替用户登录或录入真实 key，真实账号的 UI 保存及 AMD 上游仍待用户体验验收。
- C7：已生成并实际使用 `.local/start-campusmate.ps1`，Windows API/Worker 在 8788 以 postgres 模式运行；5176/8787 保持运行。HTTP 代理为 Windows 原生进程，无 CampusMate WSL 服务依赖。

详细启动与恢复说明见 [CLOUD_RUNTIME_SETUP.md](../CLOUD_RUNTIME_SETUP.md)。本次只本地提交，没有 push/PR/main 变更。数据库接入已完成；真实账号 UI 和真实模型验收边界保持上述标记。
