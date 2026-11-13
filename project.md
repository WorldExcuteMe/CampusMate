# CampusMate · project.md

> **长期状态文档**：每完成一个任务实时更新本文件（状态/决策/阻塞/变更日志）。团队三人（均用 Qoder）与 Agent 以本文件为最新事实来源。工程细节见 `docs/` 八份工程文档。

- 项目：**CampusMate（校园机会管家）** — 面向大学生的智能信息管理、机会发现、可信度核验与个人成长 Agent
- Slogan：让重要信息不再被淹没，让有价值的机会真正变成行动。
- 仓库：https://github.com/WorldExcuteMe/CampusMate（PUBLIC）
- 比赛提交截止：**2026-11-30**
- 主提示词存档：本地 `C:\Users\Asus\CodeBuddy\campusmate-evidence\master-prompt-2026-11-12.md`（不上传）

## 1. 硬约束（用户指定，优先级最高）

1. 最终作品经 **Qoder Sites 部署 + 公开访问**，评委点开即用；整体必须能塞进 Qoder Sites（静态前端 + 外部 Supabase 后端）。**开发阶段不公开，先私有研究**。
2. **GitHub 上传有取舍**：三人均用 Qoder，内部 skills、.qoder 配置、环境审计等无关紧要文档不上传（见 §6 上传策略）。
3. 重要过程**自动截图**存本地 `C:\Users\Asus\CodeBuddy\campusmate-evidence\`（仓库外，不上传 GitHub），用于作品材料增强可信度。
4. 本文件任务后实时更新，保证团队与 Agent 记忆最新。
5. 一切工程服务于参赛实际：MVP 优先、核心闭环优先、不扩范围、不造假证据。

## 2. 团队与分工（主提示词 §14）

| 成员 | 角色 | 负责 |
|---|---|---|
| Member A | 技术负责人（网络安全） | 架构、Agent Orchestrator、Trust Engine、后端、数据库、安全审计、最终集成 |
| Member B | 前端与交互（机器人专业） | Dashboard/Inbox/Radar/Growth UI、交互设计、浏览器测试 |
| Member C | 数据工程（计算机专业） | 官方信息源、机会采集、清洗去重、测试集、推荐数据 |

协作：GitHub Issues / Branch / PR / Code Review。远程仓库已存在（CampusMate）；**push 与公开访问变更需用户确认**。

## 3. 技术栈（主提示词 §3，已定）

- 前端：React + Vite + TypeScript + Tailwind CSS + shadcn/ui 风格组件 + Lucide + React Router + TanStack Query + React Hook Form + Zod + Recharts
- 后端：**Supabase 唯一业务数据源**（PostgreSQL / Auth / Storage / Edge Functions / RLS），Migration 管理变更，不建第二套数据库
- AI：独立 LLM Provider Adapter（LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL；Key 仅服务端；结构化输出；超时重试；成本记录；**Mock Provider 明确标识**）
- 文档解析：PDF.js / Mammoth / Vision LLM（txt、png、jpg、pdf、docx）
- 采集：Fetch + Cheerio + RSS，官方白名单，第一版人工维护来源+种子数据，不建全网爬虫，不绕登录/验证码/反爬
- 测试：Vitest + React Testing Library + Playwright + Zod + Migration
- 部署：GitHub + GitHub Actions CI + Qoder Sites（公开 Demo）

## 4. 当前状态（2026-11-12）

| 项 | 状态 |
|---|---|
| Phase 0 环境/资产审计 | ✅ 完成（docs/research/，本地不上传） |
| Gate 0A | ✅ 已确认 |
| 主提示词接收 | ✅ 2026-11-12，存档本地证据目录 |
| project.md | ✅ 本文件，持续更新 |
| 八份工程文档 | ✅ 完成（docs/） |
| Sites 兼容性验证 | ✅ 文档级确认（静态 dist + spa:true 回退 + 域名根 + 外部 Supabase + 50MiB 限制 + 保留路由命名空间）；构建级验证待 npm install 后跑 |
| 工程脚手架 | ✅ web/ 已初始化（React19+Vite8+TS+Tailwind4+shadcn），依赖安装中 |
| 数据库 Migration | ✅ supabase/migrations/0001_init.sql（14 表 + RLS + 索引） |
| Mock Provider + Demo 数据 | ✅ rule-based Mock + 虚拟档案/5通知/3竞赛/2实习/1科研/3待办/1报告 |
| 第一条业务闭环 | ✅ 完成并验证（E2E 3/3 通过：导入→提取→审核→确认→待办→Dashboard→刷新持久化） |
| 单元测试 | ✅ 18/18 通过（extractor/classifier/urlGuard/orchestrator） |
| E2E + CI | ✅ Playwright 3/3 通过（桌面端）；CI 配置就绪 |
| 构建 | ✅ tsc + Vite 通过，dist 产物 JS 240kB gzip（远低于 Sites 50MiB） |
| 浏览器 Preview | ✅ 桌面+移动渲染验证，截图存 campusmate-evidence/（01-08） |
| Sites 工作台 | ✅ 已注册 .CampusMate.qoder.site；私有云端草稿已准备（access_mode=private，published=false，草稿地址 campus-mate-32iqk4j3tlf.qoder.zone），出现在「我的站点」；公开发布待用户确认 |
| DeepSeek 接入 | ✅ 服务端代理实测连通（deepseek-flash，JSON Mode）；密钥仅服务端 .env.local（gitignored） |
| 自定义供应商 | ✅ 设置页 Provider ID/显示名/API地址/协议/密钥；密钥一次提交存服务端，前端零密钥 |
| Agent 对话 | ✅ /app/agent，ReAct 工具循环（提取/日常/搜索/匹配），Mock 降级 |
| 日常任务专区 | ✅ /app/daily，群通知清洗+去重+时间提取+导入 |
| 调优调研 | ✅ docs/AGENT_RESEARCH_AND_TUNING.md（模型路由/上下文/工具/embedding/记忆/QQ-WX/搜索） |
| Supabase 真实项目 | ⛔ 需人工配置（见 §7） |
| LLM 真实 API | ⛔ 需人工配置（见 §7），先用 Mock |

**第一条业务闭环（最高优先）**：导入校园通知 → 文本解析 → AI 提取 → 分类 → 优先级 → 用户确认 → 保存 Inbox → 生成待办 → Dashboard 展示（验收 10 条见 docs/PRODUCT_SPEC.md）。

## 5. 关键决策记录（ADR 摘要，详见 docs/ARCHITECTURE.md）

| # | 决策 | 状态 |
|---|---|---|
| ADR-001 | 模块化单体：React SPA + Supabase（Postgres/Auth/Storage/Edge Functions），不上微服务 | ACCEPTED（主提示词指定） |
| ADR-002 | Qoder Sites 托管 Vite 静态构建产物；Supabase 为外部后端；不在 Sites 重复建业务库 | PROPOSED（待兼容性验证） |
| ADR-003 | Demo Mode 用明确标识的本地 Demo 数据层（localStorage），与真实用户数据（Supabase+RLS）隔离；无凭证时闭环以 Demo+Mock 跑通 | PROPOSED |
| ADR-004 | Agent 核心逻辑为共享 TS 模块（Zod Schema），Demo 在浏览器跑 Mock，生产经 Edge Function 调真实模型，Key 不落前端 | PROPOSED |
| ADR-005 | 开发阶段私有；发布与公开访问变更需用户确认 | ACCEPTED（用户指定） |

## 6. GitHub 上传策略

**上传**：README.md、project.md、docs/ 八份工程文档、web/ 源码、supabase/migrations、tests、.github/ CI 与模板、LICENSE（待定）。
**不上传**（.gitignore 排除）：docs/research/（内部审计）、.qoder/（本地 Qoder 配置与 skills）、AGENTS.md 本地协作层、node_modules/、dist/、.env*、本地证据与截图、主提示词存档。

## 7. 阻塞与待人工配置

| 项 | 说明 | 影响 |
|---|---|---|
| Supabase 项目 | 需 URL + anon key（服务端另需 service key）；MCP supabase 已连接，可经确认后建项目/跑 migration | 真实用户模式；不阻塞 Demo 闭环 |
| LLM API | LLM_PROVIDER/BASE_URL/API_KEY/MODEL；无则 Mock Provider（明确标识） | 真实 AI 提取；不阻塞 Mock 闭环 |
| Sites 发布/公开 | 需用户确认后执行 | 最终交付 |
| 工程宪章 | 已由主提示词替代补齐 | 无 |

## 8. 时间规划（主提示词 §16）

11.12–11.14 工程初始化/数据库/设计系统 → 11.15–11.19 Inbox → 11.20–11.22 Radar → 11.23–11.24 Trust → 11.25–11.27 Growth+Dashboard → 11.28–11.30 测试/Demo/Sites 部署/作品材料。预留部署与修复时间。

## 9. 变更日志

- **2026-11-12**：Phase 0 完成并确认 Gate 0A；仓库初始化（main，origin=CampusMate）；接收主提示词；建立 project.md；确定上传取舍与截图留存策略；开始八份工程文档与工程构建。
- **2026-11-12（续）**：八份工程文档完成；Sites 兼容性文档级确认；web/ 脚手架（捆绑 React starter + 补齐 router/query/supabase/解析/测试依赖）；核心逻辑层（schemas/llm mock+openai/agent extractor+classifier+orchestrator/data demo+supabase/security urlGuard）；Demo 种子数据；13 页面 UI（品牌 indigo 主题）；0001_init.sql（14 表+RLS）；单元测试 + Playwright E2E + CI；README/.gitignore/.env.example。依赖安装中，待构建/测试/Preview 验证。
- **2026-11-12（夜）**：build+18 单测+5 E2E 全过；Sites 私有草稿注册并显示；DeepSeek 服务端代理实测；自定义供应商设置（密钥保密）；Agent 对话+工具循环；日常任务专区+QQ/WX 清洗管线；docs/AGENT_RESEARCH_AND_TUNING.md 调优方案。截图 01-12 存本地证据目录。
- **2026-11-13**：Supabase 真实模式接线（auth.tsx 登录/注册+会话绑定+RLS）；DB 密码存 web/.env.local（gitignored）；Project URL 写入 web/.env；实测 supabase.co 直连被墙需代理、远程 MCP 不可用→密钥/SQL 走 dashboard；docs/SUPABASE_SETUP.md 更新。待用户复制 Publishable key 后完成 .env 与验证。
- **2026-11-13（续）**：Publishable key 已写入 web/.env 并重新构建（key 经真实 REST URL 验证有效，PGRST205=表未建）。用户在 SQL Editor 误粘文件路径致语法错误→已提供完整建表 SQL 待粘贴执行。DB 直连/SOCKS 隧道在本机网络不可用，建表走 dashboard SQL Editor。
- **2026-11-13（完成）**：用户执行建表 Success；经真实 REST URL 验证 14 表+RLS 生效（opportunities/tasks 可读、inbox_items 匿名空=隔离）。双模式就绪：默认公开 Demo（无需注册）+ /login 登录真实模式（会话绑定+RLS）。build+18 单测+5 E2E 全过；preview 4173 与 LLM 代理 8787 存活。Supabase 设置完成。
- **2026-11-13（夜）**：GitHub 基线推送 main+develop，分支保护（main/develop 需 PR+CI build-test+1 评审），CI/preview/release workflow+CONTRIBUTING。会话 UI 优化：会话列表/开始即命名/可编辑/点击展开/无边框消息流/模型选择在输入框下 Enter 左/上下文状态。双预设（自动/日常）。QQ 摄取：group_export.py（--name/--uin，信息本位：日期/关键词/文件，不限人）+ sync_group_notices 工具 + 容器联动（Inbox/日常/雷达/Dashboard）+ skill qq-wechat-ingest + workflow 文档。实验：64 位 Python key 提取+decrypt(--no-wal) 成功（31 表）；QQ NT 库无群名表→群名→uin 缺口，提供 --uin 手动路径；微信本地解密待实现（转发导入已可用）。群名更正为「网安2401官方群」。
- **2026-11-13（深夜）**：微信解密适配器完成：wechatkit（decrypt SQLCipher page4096/reserve80/HMAC-SHA512/KDF256000；scanner Weixin.exe 指针解引用+页1HMAC 取钥 best-effort；exporter 群信息本位+zstd 解压）+ wechat_cli.py（key/decrypt/group/run/clean）；/api/ingest/wechat + 会话页同步覆盖 QQ+微信。QQ 群号辅助：groups.json（name→uin）+ group_export --uin/群号解析。build+20 测试全过。微信取钥扫描 best-effort（慢，后台有上限），可靠路径 --key（chatlog 获取）。
- **2026-11-13（UI+自动）**：会话列表并入左功能栏（点击「会话」向下展开，SessionsProvider 共享状态，移除独立会话边框列）；会话页新增工作区栏（参考 Qoder/DeepSeek harness：本地工作区路径+64位Python+py 摄取说明）。微信 --auto 一键自动化：内存取钥→失败自动经 chatlog（真实 GitHub release）取钥→解密→导出；/api/ingest/wechat --auto。build+20 测试全过。
- **2026-11-13（零配置+附件）**：工作区下移到聊天输入栏左+自定义本地路径；输入框支持图片/文档（回形针附件/拖拽/Ctrl+V 粘贴，PDF/DOCX 解析 pdfjs/mammoth）；SetupWizard「grill me」问答式零配置引导 + /api/env/check；skills/env-setup + docs/ENV_SETUP_WORKFLOW.md；微信 decrypt 多参数自动探测（wechat4 SHA512/256000/reserve80 + wechat3 SHA1/64000/reserve48，跨版本通用）。build+20 测试全过。
- **2026-11-13（普适+完全访问）**：① 普适群发现——group_export.py `--list` 单次顺序全表扫描枚举本机所有群（uin/总数/信息密度/内容样例），修复 Windows GBK stdout 遇 emoji 崩溃（reconfigure UTF-8）；/api/ingest/qq/groups 端点（实测 200/5.9s/45 群）；list_groups 工具；sync_group_notices 省略群名时按信息密度自动定位（不再硬编码网安2401），群名缺失靠样例语义识别，普适各主机。② 完全访问工具——run_terminal/read_file/write_file/web_fetch/rag_search 接入 executeTool + /api/terminal、/api/fs/*、/api/web/fetch、/api/rag/search。③ 模型无关——runChat 增 JSON 工具回退（parseJsonTool，无原生 tool_calls 的模型输出 {"tool","args"} 亦能执行），兼容任意 OpenAI-compatible API；工具循环上限 4→6。④ URL 完整性——web_fetch 经 guardUrl 校验，拒绝代理/内网替换，每次重核真实目标；/api/web/fetch 仅请求任务给定真实 URL。⑤ 反幻觉实测——/api/llm 转发 tools，deepseek-flash 真实返回 list_groups tool_call（非虚构 <tool_result>）；uin 摄取实测 200/437 条真实记录。build+20 单测+5 E2E 全过。
- **2026-11-13（修复 JSON 降级 BUG）**：用户报「当前未连接真实模型（Unexpected end of JSON input）」降级 Mock。浏览器复现+网络/控制台抓包定位根因：新增完全访问端点 /api/terminal、/api/fs、/api/web、/api/rag 未进 vite 代理表，模型调 rag_search 时 4173 返回 404 空体，executeTool 的 .json() 解析空体抛 SyntaxError 冒泡到 runChat catch 被误判为「未连接模型」。修复：① vite.config 代理改为整段 /api→8787（普适覆盖现在/将来所有端点，杜绝漏配）；② executeTool 增 toolPost 安全调用（非 OK/空体/非 JSON 返回可读 error，不抛异常），五个完全访问工具改用之；③ sync_group_notices/list_groups 加 try/catch 返回工具错误；④ llmChat 先读 text 再解析，空体/非 JSON 给含 HTTP 状态的可读错误；⑤ runChat 降级文案改为「真实模型调用中断（原因）」不再误报未连接。浏览器端到端实测：摄取消息真实模型回复（非 Mock），自主按信息密度定位群 1013201012/120492103，新增 Inbox 14/机会 2，过滤过期 97 条，声明不虚构内容；/api/rag/search 经 4173 由 404 空体→200。build+20 单测全过。