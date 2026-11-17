# Windows 开发环境连接云端 Supabase

2026-11-15。当前工作区使用原有 Supabase 项目的 Auth、REST 和 Postgres；本机只运行 Windows Node 前端及 API/Worker。日常运行不需要启动 WSL 或本地数据库容器。云数据会在本机应用关闭后继续保留；本机 Worker 关闭期间不会执行新任务。

## 当前机器启动与使用

在工作区运行（入口及私有配置均已生成，未纳入 Git）：

```powershell
& .\.local\start-campusmate.ps1
```

访问 http://127.0.0.1:5176/ ，使用原有账号登录，再进入“设置 → 模型供应商”。Demo 不是已登录账号，不能保存个人 API 密钥。添加连接后再点击“测试连接”，成功后设为默认模型。服务端不会从聊天截图导入密钥。

- `5176`：现有 Vite 页面；`8787`：现有开发代理；`8788`：绑定 loopback 的认证 API/Worker。
- 此机器数据库日常已改为原项目的 IPv4 Session Pooler（5432），数据库不需要 HTTP CONNECT。模型和搜索继续使用配置的 Windows HTTP 代理，不依赖 WSL。
- `.local/logs/` 保存新启动进程的日志。已有前端进程继续使用启动时的日志位置，脚本复用已监听端口。
- 启动入口复用进程，不能用它热加载已运行后端的 `.env`。修改配置后，应确认进程归属再重启该后端；不要停止其他项目或全局关闭 WSL。
- API `/v1/health` 的 `store=postgres` 表示装配了持久化存储；数据库是否可达还需认证读写验证，不能仅靠该字段判断。

## 配置契约

前端原有 Supabase 项目、用户和 `VITE_BACKEND_URL=http://127.0.0.1:8788` 保持一致。后端私有 `backend/.env` 配置下列字段；禁止将真实值提交到 Git 或复制进问题报告：

| 字段 | 用途 |
| --- | --- |
| `DATABASE_URL` | 现有云 Postgres 连接串，密码需 URL 编码 |
| `DATABASE_PROXY_URL` | 可选显式 HTTP(S) CONNECT 代理；不配置时沿用直连 |
| `DATABASE_SSL_CA_FILE` | 官方项目 CA；相对路径以 `backend/` 为基准，也可绝对路径 |
| `SUPABASE_JWT_SECRET` / `SUPABASE_JWKS_JSON` | 原有 legacy 验签配置及当前项目公开 JWKS；本机已刷新 JWKS，支持非对称用户 token |
| `PROVIDER_MASTER_KEY` | AES-256-GCM 的服务器主密钥；已生成，后续启动必须保留 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 当前机器 Node HTTP 请求的代理；loopback 在 `NO_PROXY` 中 |

Node 24 启动时需使用 `--use-env-proxy` 才会读取 HTTP 代理变量。本机入口同时用 `--env-file=backend/.env` 在初始化 HTTP 客户端前装载配置。Postgres 采用同项目 IPv4 Session Pooler 直达，并继续验证官方 CA 和主机名；只有确有需要的环境才设置 `DATABASE_PROXY_URL`。不要同时在连接串中设置 `sslmode` 等 SSL 参数并传入显式 CA，pg 会覆盖配置，本实现对此组合明确报错。

CA 从 Supabase 控制台 Database Settings 的证书链接下载，不关闭证书或主机名校验。服务器主密钥、CA 和 `.env` 都需保留；只保存数据库但丢失主密钥，将无法解密已有供应商凭证。密钥轮换使用既有 `PROVIDER_KEY_VERSION` 和 `PROVIDER_DECRYPTION_KEYS` 契约，不能随意重新生成主密钥。

其他机器可依据 `backend/.env.example` 配置后运行既有后端入口；当前 `.local/` 启动脚本是本机配置产物，不是仓库发行安装器。

## 云端变更与验证

实际部署复用 `backend/src/runtime/migrations.ts` 的九份 SQL 清单。旧 15 表与基线的列、默认值、约束、策略先核对，既有 `0001` 登记为已存在，其余八份迁移在同一事务中补齐。原有资料记录未变。Postgres 18 的 NOT NULL 元数据与本地参考版本差异，通过独立列 nullability 核对处理。

迁移前已将旧数据及 schema/权限/触发器元数据保存到 `.local/cloud-backups/*.json.enc`：gzip + AES-256-GCM，密钥由既有主密钥派生，落盘后解密读回校验通过。Supabase 原生迁移历史已登记九条版本及源码校验标记；再次执行时 `applied=[]`，没有重复应用。不要再运行仅覆盖旧 `0002` 的历史脚本，也不要盲目 `db push` 重放已登记的旧版本。

验收记录保存在工作区外的 `campusmate-evidence`，未上传：

下列为首次云接入记录；后续真实 Gemma 及云任务修复验证见 [MODEL_TOOL_RECOVERY.md](MODEL_TOOL_RECOVERY.md) 和 [CLOUD_TASK_RESILIENCE.md](CLOUD_TASK_RESILIENCE.md)。

- 后端回归 293 项：292 通过、0 失败、1 项显式外部 `TEST_DATABASE_URL` 未配置而跳过。类型检查通过，新增代理回归 4 项通过。
- 同一 CONNECT 通道下的 TLS 负向验证通过：不可信 CA 返回 `SELF_SIGNED_CERT_IN_CHAIN`，错误主机身份返回 `ERR_TLS_CERT_ALTNAME_INVALID`；未发送数据库认证或模型请求。
- 真实云 HTTP/API → Postgres：随机诊断用户、虚构密钥、默认模型、会话、消息、排队任务及文件产物保存；实际停止并重启 API 后读回成功，凭证解密成功，列表不返回明文或密文。
- 认证 API 隔离、真实数据库 `SET LOCAL ROLE authenticated` + owner claims 的 RLS 验证通过；36 张 public 表均启用 RLS，浏览器角色看不到供应商密文。
- 原资料 hash 前后相同；只清理随机诊断用户及其关联数据，启用正式 Worker 前无诊断排队任务。测试期间 Worker 暂停，模型调用为 0。
- 浏览器已打开 5176 模型设置页，当前浏览器处于 Demo，明确提示需登录。未替用户登录或保存真实 AMD 密钥；真实账号下的页面保存与 AMD 上游连通，须由用户登录后完成最终验收。

Gemma 图像/工具及阶段思考的后续实测见上述记录。复杂写作质量和 KV Cache 收益仍需各自验收，不由数据库持久化验证代替。
