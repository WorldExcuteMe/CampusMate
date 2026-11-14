# CampusMate · project.md

> **2026-11-14 已提交 PR #5（待维护者审查合并）：** 用户授权提交后，136 文件累计修复以 6a0621c 推送到 coco38622/CampusMate 的 fix/local-integration-20261114；原仓库无直接写权限，采用 Fork → PR。按协作规则目标为 WorldExcuteMe/CampusMate:develop：https://github.com/WorldExcuteMe/CampusMate/pull/5 。develop 落后 main 的 32 个原有提交在 PR 中作为主线同步明确说明，不算今日新增；没有修改/合并原仓库 main/develop。私密配置/账号/测试产物未提交，使用 noreply 署名，未勾选维护者额外编辑/secrets 访问。下方“未提交/推送”均为各修复当时的历史状态，现由本记录替代；远端 CI/合并仍需以 PR 页面和维护者决定为准。

> **2026-11-14 最新修复：核验报告落库不再假成功。** SupabaseRepository 改用 save_verification_report 原子 RPC，报告/依据一起提交、任一失败全部回滚；同 ID 同内容重试不重复，相同 ID 不同内容拒绝且不覆盖旧记录。新增 0003 迁移已在当前本地 Docker 应用，原迁移/RLS/授权不变，浏览器无 service_role。聊天遇到核验落库失败直接 failed，不再让模型续写已保存。新增 10 web 单测、8 PostgreSQL 引擎测试、1 E2E；web 199/199、backend 199 通过/1 外部 PG 跳过、迁移验证 19/19、build 通过；真实本地 REST/SQL 回滚/并发/权限验证通过，临时数据/账号已清理。普通登录用户仍无公共核验表全局写权限，失败会如实显示；原清单第 3～5 项仍待修。没有改既有用户报告/依据、没有云端变更或付费模型/QQ 调用，未提交/推送。

> **2026-11-14 注册现场验证：** 在当前 5173 页面用随机临时账号完成真实注册、登录跳转、数据库建档、刷新恢复、退出再登录，均通过；临时账号已核对归属并删除，现有账号和通知未动。没有改业务代码或模型配置。当前仅本地环境可用、关闭邮箱确认；注册/登录仍需点击按钮，Enter 提交与共享远程账号环境尚未补齐。

> **2026-11-14 最新修复：群通知去重按账号隔离。** Repository 新增稳定 storageScope，Demo 与 Supabase 各账号分开；同步在开始时捕获该 Repository 作用域，以 v2 命名空间读写去重缓存，不依赖可编辑画像或模型参数。旧全局键因归属未知，保留但不继承/迁移；重置 Demo 只清理 Demo 的群同步缓存，不清其他账号。新增 13 单测（修改前稳定出现 11 个失败）及 1 浏览器集成测试；最终 189 单测、21 E2E、build 通过，当前 5173 入口另跑新增测试通过。浏览器测试使用真实 Repository 类和数据库返回 fixture，不冒充真实登录/RLS 验收。未修改用户通知/数据库/账号、未实际读取 QQ/调用付费模型，未改权限审批；审查第 2～5 项仍待修复，未提交/推送。

> **2026-11-14 当前审查（未修复）：** 本轮隔离复现 5 项剩余问题：群通知去重键跨账号污染；核验依据 insert 失败被忽略；日历仅按星期显示而未按真实周日期过滤；Supabase 适配层丢弃 mergedFrom；登录 Enter 不提交。详见 `docs/REMAINING_ISSUES_2026-11-14.md`，含源码行号、探针输出与修复顺序。未改业务代码、未操作用户通知/账号/数据库，不重跑全量验收；Agent 权限确认继续按用户要求暂缓。下方为已完成修复的历史记录。

> **2026-11-14 最新增量：通知合并偶发漏项已修复。** 根因是单次首组匹配的贪心聚类无法合并后出现桥接通知连通的多个旧簇，毫秒级 createdAt 倒序使失败取决于输入顺序。改为内容稳定排序、强匹配优先的连通合并；整个组检查已有截止/月份轮次冲突，避免未知日期桥接误合并；同 URL/标题不再覆盖明确冲突，空标题不误匹配。新增 11 单测（含 6 种桥接顺序、24 种入库顺序、重跑幂等和无关记录保留）及 1 Agent 浏览器 E2E。最终 176 单测、20 E2E、build 通过；去重定向 17 测试连续 5 个独立进程运行通过，5173 用户入口上另跑新增 E2E 通过。未批量运行用户通知合并，未改数据库/模型配置或 Agent 权限审批，未提交/推送。

以下保留前轮状态记录；其中“去重偶发失败未修”已由上述本轮修复替代。

> **2026-11-14 最新增量：过期管理已实现并本地验证。** Radar 默认隐藏过期/归档和日期待核实项，分组可查看全部历史；过期/归档详情禁建参与计划。Dashboard 7 天内截止排除逾期，逾期待处理单列，Growth 支持时效筛选，Daily 保留逾期完成/撤销。北京时间跨天自动更新，不自动删记录、改年份或标记完成。当前浏览器机会查询/匹配同步过滤；后台独立搜索适配器不在本轮范围。最终 web 165 单测、19 E2E、build 通过，用户 5173 入口另跑本项 2 E2E 通过；原有去重测试一次偶发失败后完整重跑通过，未修改其逻辑。未改数据库数据/模型配置，未提交或推送。详见 `docs/TEST_PLAN.md` 过期管理章节。

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

## 4. 当前状态（2026-11-14 · 同步上游 060c09b）

- main 已快进至 origin/main 的 `060c09b`，14 处冲突处理完毕，本地旧修复保留；未 commit/push。
- 上游新增 Node 24 Agent Runtime、课表/日历、会话、附件和 ink-aurora UI 均保留；模型代理、Context Repository、查询缓存等与本地修复已集成。
- 当前验证：web 134/134；backend 168 通过 + 1 真实 DB 集成跳过；PGlite 19/19；脚本化 Benchmark 30/30；E2E 10/10；build/typecheck/Deno check 通过。
- 已优化账号/会话存储隔离、Demo 种子污染、SSE/Companion 计时器与正常退出、监督启动器、本地入口跨站防护、请求体/预算；入口 JS 926.31KB → 642.09KB（仍有包体警告）。
- 本地前端/API：127.0.0.1:5173 / 8787，仍为无云端凭据的 Demo/Mock；未启用假的 Runtime 身份认证。
- 生产未完成：API/Worker 的非 TaskStore 状态仍内存隔离，需先持久化/共享；浏览器核验状态与周视图过滤需改。详见 `docs/SYNC_REVIEW_2026-11-14.md`。
- 保留 stash `1c08ea522d44db7165619cf6d2844610660f8913` 与仓库外补丁/文件备份；未动云端库或私人 QQ/微信数据。

### 11-13 本机代码修复历史

| 项 | 当前核验 |
|---|---|
| 工作区 | 本机克隆后的未提交修复；未 push、未发布 |
| UUID | 实体与 Agent run 统一 crypto.randomUUID，兼容 PostgreSQL uuid |
| 新用户建档 | getProfile 并发安全兜底；0002 增加注册触发器与历史回填，云端尚未执行 |
| 会话隔离 | Repository 由 Context 同步提供；A/B/Demo 分别持有 QueryClient，会话读取竞态与 StrictMode 已回归 |
| AI 接线 | 本地与生产 Function 共用 handler；工具透传；Inbox 自动选择服务端/Mock，来源标记持久化 |
| 生产鉴权 | Supabase Auth 在线验 token；生产供应商仅 Secret 配置、只读；未进行实际部署 |
| 单元/契约测试 | 44/44 通过（模型/Auth/REST 使用 fixture，不等于云端验收） |
| E2E | 6/6 通过（本机 Chrome，含模型接口 fixture 与持久化标记） |
| 构建/Function | tsc + Vite 通过；Deno 2.9.6 检查通过；本地 Node HTTP smoke 通过 |
| 云端待办 | 配置本机 Supabase/服务端 Secret、执行 0002、部署 Function、双账号 RLS 与付费模型实测 |

配置及边界见 `docs/AI_BACKEND_SETUP.md`。本机没有从其他开发者环境复制凭据；以下历史记录不能视为当前云端状态或本机验收。

### 原环境初始化记录（历史）

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
| Supabase 项目 | 本机需 URL + anon/publishable key，已有项目需执行 0002；未核验原环境云端状态 | 真实模式验收；不阻塞 Demo |
| LLM API | 服务端 LLM_BASE_URL/API_KEY/MODEL 与 Supabase Auth 配置；无则明确 Mock | 真实 AI/生产 Function 验收 |
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
- **2026-11-13（修复 JSON 降级 BUG）**：用户报「当前未连接真实模型（Unexpected end of JSON input）」降级 Mock。浏览器复现+网络/控制台抓包定位根因：新增完全访问端点 /api/terminal、/api/fs、/api/web、/api/rag 未进 vite 代理表，模型调 rag_search 时 4173 返回 404 空体，executeTool 的 .json() 解析空体抛 SyntaxError 冒泡到 runChat catch 被误判为「未连接模型」。修复：① vite.config 代理改为整段 /api→8787（普适覆盖现在/将来所有端点，杜绝漏配）；② executeTool 增 toolPost 安全调用（非 OK/空体/非 JSON 返回可读 error，不抛异常），五个完全访问工具改用之；③ sync_group_notices/list_groups 加 try/catch 返回工具错误；④ llmChat 先读 text 再解析，空体/非 JSON 给含 HTTP 状态的可读错误；⑤ runChat 降级文案改为「真实模型调用中断（原因）」不再误报未连接。浏览器端到端实测：摄取消息真实模型回复（非 Mock），自主按信息密度定位群，/api/rag/search 经 4173 由 404 空体→200。build+20 单测全过。
- **2026-11-13（北京时间感知+过期过滤）**：用户指出呈现的都是过期通知（截止 2026-02~04，当前北京 2026-11-13）且疑幻觉。修复：① clean.ts 增 beijingNow/todayBeijing/nowBeijingText/isExpired（Asia/Shanghai）；② SYSTEM 注入当前北京时间+规则10时间本位（过期不得作为当前可行动项，总结/RAG 只呈现未过期或标注已过期）；③ syncGroupRecords 按 extracted.deadline 与日常 dueAt 过滤过期（新增 expired 计数），相对日期（今天/明天/周X）改相对消息发送时间 ref 解析而非现在；④ RAG 结果带消息 time 字段供时效判断。新增 timeAware.test.ts 3 测试。浏览器实测群 881289395：同步 Inbox90/机会55/过期过滤54，按 2026-11-13 仅列未过期 11-16~22 讲座为可行动，过期项标"已过期仅列出"，标注来源不虚构。build+23 单测全过。
- **2026-11-13（附件通知收纳）**：用户要求收纳以 PDF/DOCX/图片辅助发送的通知（如群881289395 第四届职规赛校内选拔赛 PDF+海报）。新增 qqkit/attach.py + ocr.ps1（Windows WinRT 中文 OCR，无第三方依赖）：图片本地优先 Pic/<月>/Ori|Thumb→OCR；文件读本地真实文件（DOCX 标准库 zip 解包/PDF pypdf 可选）或 File/Thumb 首页预览 OCR；文件通知以真实文件名收纳为通知（文件名即标题）。仅当图片本地缺失且确需时用消息自带真实链接（45816主机+45804路径逐字）下载，实测 CDN 400 需鉴权→熔断转本地；OCR 限流(--max-ocr)+缓存(out/attach_cache)、近期优先(倒序)。group_export 接入 mtype2/3（--no-attach/--max-ocr/--no-network）；/api/ingest/qq 超时 120→180s。实测：职规赛 PDF 通知收纳 2 条；本地通知图 OCR 收纳、过期事件过滤。新增 attachIngest.test.ts 3 测试。build+26 单测全过。
- **2026-11-13（上下文窗口调优）**：用户见「上下文 83,762/16,000」质疑超窗不压缩、能否上 200K。诊断：该数字为累计 usage（工具循环多轮 input+output 相加）非实时占用；CONTEXT_CAP=16000 硬编码且全链路无裁剪/压缩。核实 DeepSeek 官方文档（api-docs.deepseek.com，真实链接）：V4 Flash/Pro 上下文 1M/输出 384K → 200K 可行。新增 lib/agent/context.ts：模型感知上限 registry（deepseek 1M/kimi 256K/claude 200K/gpt-4o 128K/默认 128K）+ 默认工作上限 200K（min(工作,模型上限)，可 override）+ token 估算（CJK 1/字、其余 4 字符/token）+ composeContext 预算分配（system+工具+摘要+近期历史+输入+输出预留 8K）+ 工具结果截断 6K + 旧轮裁剪+抽取式摘要（摘要按剩余预算截断，极小 cap 不超窗）+ trimToBudget 工具循环内再裁剪。runChat 接入并返回 contextUsed/contextCap/compressed；sessions 增字段；UI 改显示实时占用/模型上限+「已压缩」徽标+组成 tooltip，累计用量单独计。新增 context.test.ts 8 测试。build+34 单测全过。
- **2026-11-13（语义合并+思考强度）**：① 通知语义去重合并——用户指 Inbox 重复（模拟面试大赛正式通知+小程序+宣传语本质同一事件）。新增 lib/ingest/dedupe.ts：归一标题(去[小程序]/(1)/公文套语)+事件核心(去机构/年份/届次/级别)+bigram Dice+包含匹配，阈值0.6 用真实语料调校；轮次/截止冲突不合并(3月vs9-11月奖学金保留)；传递聚类(与簇内任一成员相似即归簇)；mergeInbox 富化规范条(mergedFrom+摘要标注)+重复条归档，含历史通知；接入 syncGroupRecords(同步后自动合并)+merge_inbox 工具；InboxItem.mergedFrom。② 思考强度策略——lib/llm/reasoning.ts：默认 low 覆盖提取/分类/去重/路由/总结/检索(本环境复杂度在检索广度非推理深度)，仅核验/冲突升级 medium；按模型安全映射(OpenAI reasoning_effort/Qwen enable_thinking/DeepSeek 由模型选择决定不下发非法参数)；thinking 预算上限 1K/4K/16K；proxy 服务端解析模型后合并参数、llmChat/runChat 透传默认 low。新增 dedupe.test.ts 6 + reasoning.test.ts 5 测试。build+45 单测全过。
- **2026-11-13（工具上限修复）**：用户报「达到工具调用上限，请细化问题」。根因：runChat 工具循环固定 6 轮，多工具（list_groups/sync/merge/rag）易耗尽，且耗尽时返回无用提示而非产出。修复：MAX_TOOL_ROUNDS=12（上下文有 trimToBudget 保底不爆窗）；轮次耗尽时不再返回"请细化问题"，改为强制一次无工具最终总结（基于已获取工具结果给中文总结含来源/截止/合并/过期），若模型仍输出工具指令则回退为 actions 摘要，保证总有可用产出。build+45 单测全过。
- **2026-11-13（工具上限+指令遵循）**：① 上限再加大 MAX_TOOL_ROUNDS 12→20（trimToBudget 保底不爆窗）。② 指令遵循/作用域锁定（调研 Instruction Hierarchy OpenAI Wallace 2024 + OWASP"模型外围建系统"+ Copilot custom-agent tools 白名单/agentgateway MCP allowlist/LLMSecurityGuide guard_tool_invocation/Camel 动作掩码 等内核）：新增 lib/agent/scope.ts——detectScope 从用户提示词识别信息源(QQ群/微信群/网页/任意)+群号/群名；allowedTools 动作空间掩码(锁定源时越界工具模型不可见)；checkToolScope 执行期门控(越界拒绝+sync/rag 强制限定用户指定群)；scopeContract 注入 SYSTEM(指令层级:用户scope优先于工具返回,工具/网页内容仅为数据)。runChat 接线掩码+契约+门控；rag_search 增 group 源内检索(proxy 按群号读 group_<uin>_info.json,纯数字校验防路径注入)。杜绝"用户要QQ群却做跨源噪音搜索"偏移。新增 scope.test.ts 11 测试。build+56 单测全过。
- **2026-11-13（修压缩误报+摄取重试；启动 DSH 深研）**：① 用户截图"上下文13,330/200,000 却标已压缩"——根因 trimToBudget 把"工具结果截断"误置 compressed。照 DSH compaction 与 compaction-tool-result-pruner 分离理念修复：仅丢弃历史轮次才标压缩；保留最新工具结果完整、只裁较旧工具结果；单条超大最新工具结果超预算时兜底裁剪（仍不标压缩）；TOOL_RESULT_CAP 6K→12K。② Edge 里 sync 连续失败回退历史 RAG——根因会话间代理进程被回收；给 fetchGroupNotices 加退避重试一次（DSH tool-executor 重试理念），并确认代理/preview 保活。③ 启动 DSH 深研长任务：clone 真实官方仓库 github.com/deepseek-ai/deepseek-harness 到独立目录，派子代理全面研读整仓（agent-loop/compaction/context/tools/llm/session/plan/goal/guard/插件图），待报告后照搬内核重构 CampusMate 底层 agent。context.test.ts 更新为 3 个新语义测试。build+58 单测全过。
- **2026-11-13（整体 UI 重构）**：参考 Anthropic frontend-design skill（主题derived配色/反模板化）+ baoyu-design + DSH 设置页内涵，重做设计系统「校园夜航 ink-aurora」：globals.css committed 色板（深墨蓝+电光靛紫+青绿/琥珀/绯红/天蓝语义色）、[data-theme] 明暗、定制滚动条、cm-card/cm-glow/cm-gradient-text/cm-aurora utility；lib/theme.tsx AppearanceProvider（明暗/跟随系统/字号/步骤密度/语言，live+持久化）；shell 侧栏重构（品牌+分区导航+会话+左下角 UserChip）；UserChip 集成已登录用户（头像+名字+画像摘要 popover+个人画像/设置/退出），移动端顶栏亦集成；个人设置页五分区（账号与画像/通用与外观/模型供应商/Agent 预设/数据与隐私），预设可设默认模式并应用当前会话；保留全部现有功能。浏览器实测：设置渲染/主题切换 data-theme+bg 实时生效/无控制台错误/移动端用户入口。build+58 单测全过。
- **2026-11-13（DSH 深研+内核移植）**：clone 真实官方仓库 github.com/deepseek-ai/deepseek-harness 全面研读（子代理整仓报告：Cordis 插件图/append-only 会话日志+surface 折叠/turn-step 双 inbox/三级事件/三层上下文瘦身/五层 fail-closed 工具门控/durable 重试/崩溃修复/子代理隔离）。照搬可移植内核到 CampusMate：① 三层上下文瘦身分离+事件类型即标签——执行期 spill（head4096+tail1024+省略量+取回提示，不标压缩）/历史期 prune（标"工具截断"）/历史期 compaction（标"已压缩"），阈值公式 min(窗口*0.8, 窗口-预留-65536)、保留尾16%；② repeat-tool-reminder（canonical 参数链+3/5/8 阈值注入提醒，只 enrich 不 veto，防死循环）；③ 工具超时 wrapper（60s 结构化 TOOL_TIMEOUT）；④ llm-retry 指数退避 500ms→10s+jitter、Retry-After 优先、可重试状态码 429/5xx；⑤ pruned/compressed 双标签上报 UI。新增 dshKernel.test.ts 3 测试。build+61 单测全过。事件溯源会话日志/子代理隔离等 P0 余项列入后续路线（见 docs/ARCHITECTURE.md 路线）。
- **2026-11-13（根治模型调用中断）**：用户截图"真实模型调用中断(proxy unavailable)"。根因：LLM 依赖独立本地 llm-proxy 进程，dev/preview 不自动拉起、会话间被回收/崩溃即整轮降级 Mock；catch 报 generic 掩盖真因；其他用户（不手动起代理/部署站点无本地代理）必遇同类。修复：① dev/serve.mjs 监督启动器——dev/preview 自动拉起 llm-proxy 且崩溃 1s 自愈，再启 vite；② llmChat 网络失败/502/503/504 退避重试(800ms×2^n,3次)+真实错误+部署态 VITE_LLM_EDGE_URL 回退；③ catch 报真实原因(String(err))。实测：监督启动双端口存活；杀代理子进程→1s 自动重启新 PID→/api/llm 恢复。build+61 单测全过。
- **2026-11-13（sync_group_notices 普适化）**：用户报 sync 两次失败"群摄取失败"。根因叠加：代理瞬断（已自愈）+硬编码本机 python/QQ工具路径+摄取工具在仓库外（其他用户没有）+明文库需手动解密。修复：① QQ 摄取工具入仓 tools/qq-ingest（qqkit/group_export/qq_cli/ocr/wechatkit，排除机器专属 data/out）；② proxy QQ_DIR 默认入仓目录（修正 root=web 需 ../tools）、PY64 自动探测64位（miniconda/anaconda/Programs/python/python3/py 候选+struct 校验）；③ 入仓 group_export 缺明文库自动 best-effort 取钥+解密（qq_cli key+decrypt --no-wal），失败给可操作提示；④ 摄取错误分类 code+hint（QQ_DB_NOT_FOUND/QQ_KEY_FAILED/DECRYPT_FAILED/GROUP_NOT_FOUND/PYTHON_MISSING）；⑤ fetchGroupNotices 透传 error+hint。实测入仓路径端到端 200/231 条（自动探测+自动解密，不依赖 Documents/QQ工具）。build+61 单测全过。
- **2026-11-13（四问题修复）**：用户贴原始聊天日志报四问题。① 开局模型调用中断"[object Object]"：根因上游错误体为对象却被 new Error(对象) stringify；llmChat 提取 e.message、proxy 归一化上游错误为字符串，暴露真因；新增 llmError.test.ts 3 回归测试。② 信息偏赛事：扩 group_export 关键词（生活/教务/活动/其他：放假/缴费/宿舍/失物/考试/成绩/选课/毕业/公示/名单等），SYSTEM 规则6 要求归纳覆盖全类别不得只报赛事。③ 无法写 inbox：merge_inbox 仅去重不新建；新增 save_to_inbox 落库工具（executeTool+scope 三表+SYSTEM 规则6 总结后逐条落库）。④ 对话体感：UI 移除"已同步/RAG/合并"actions 噪声块；SYSTEM 规则12 回复只给结论不提及工具名/调用过程/内部噪声、落库静默结尾一句告知。build+64 单测全过。
- **2026-11-13（review+覆盖率+通用agent）**：全项目 review；vitest v8 覆盖率全 src 行 9.38%、lib 逻辑层 43.75%（核心 classifier/context/dedupe/scope/reasoning/schemas/urlGuard/tools 94–100%，chat 循环待补单测）。补齐容器写入：create_opportunity(雷达)/verify_opportunity(核验)/set_growth_goal(成长)/web_search(广泛搜索)/create_plan(长任务)；Repository 增 createReport(demo+supabase)；memory.ts 计划+滚动记忆 checkpoint（跨轮注入抗幻觉不丢记忆，移植 DSH plan/goal/session）；scope 三表补写入工具；proxy /api/web/search 真实 DuckDuckGo。产出 docs/AGENT_GENERAL_PLAN.md（通用agent大型计划+头脑风暴+DSH对标量化0–5+benchmark提示词11条）。build+64 单测全过。
- **2026-11-13（自主能力+会话管理）**：① 短提示词全新环境自主：ingest 意图无密钥时先自主 bootstrap（proxy /api/ingest/bootstrap 自动 qq_cli key+decrypt），失败才引导人工；自主链 detectScope→bootstrap→list_groups→sync→总结→落库；docs 增10条短提示词全新环境考验用例。② 会话删除确认真删除（localStorage remove）；新增归档 archived+恢复；删除二次确认（点删除→"确认删除?"再点才删）；侧栏归档切换。benchmark 自动化 npm run benchmark（5场景）。build+69 单测全过。
- **2026-11-13（本机修复）**：修复 UUID/数据库类型冲突、新用户画像初始化、会话切换查询缓存及恢复竞态、LLM 工具漏传、Inbox 固定 Mock 与回退误标；新增 0002、共享鉴权 Function、服务端参数/超时/体积/单实例限流；移除无实现的协议选项；E2E 截图跨机器路径与 gitignore 修复；44 单元/契约测试 + 6 E2E + build + Deno check + 本地 HTTP smoke 通过。模型/数据库回归使用 fixture；云端迁移、部署和真实模型尚未执行，未 commit/push。

- **2026-11-14（本机同步与优化）**：同步上游 PR #4 至 060c09b，保留原修复并处理冲突；完成当前 §4 所列优化和回归，残余 P1/P2 记录在 SYNC_REVIEW_2026-11-14.md。未推送、未执行生产变更。

- **2026-11-14（日常任务复选框）**：修复取消勾选仍写 done 的单向更新错误；勾选写 done、取消写 todo，保存期间禁用重复点击，失败提示且保留原状态；新增 2 项组件测试及 1 项刷新持久化 E2E，web 132/132、E2E 7/7、build 通过。未清空现有任务。

- **2026-11-14（左右独立滚动/待办确认）**：桌面侧栏导航/会话与右侧内容分别滚动，品牌与账号固定；换页只重置右侧滚动，聊天页改为适应内容区高度。Today 待办勾选先弹确认，取消/Esc 不写入，确认后保存，保存中防重复，失败保留弹窗供重试。日常任务原有直接撤销完成保留。新增 2 项组件及 3 项 E2E，web 134/134、E2E 共 10 项通过，build 通过；桌面/手机窄屏与长会话列表已检查。未操作用户浏览器现有任务。

- **2026-11-14（Agent 深入复核，仅诊断）**：本地脚本化反例确认工具失败仍 succeeded、单轮工具超预算、取消后仍执行下一不同参数工具、concurrency 串行、同 session 新任务缺前轮历史；另确认非 TaskStore 内存隔离和浏览器兼容权限边界不一致。详见 docs/AGENT_REVIEW_2026-11-14.md；本轮未改 Agent 逻辑、未调用真实模型/主机工具。

- **2026-11-14（DeepSeek invalid_tools 修复）**：用户已有 t1dp / deepseek-flash Key；本地共享代理 16 工具上限误拒绝 Agent 的 17/18 工具请求。改为有界 128 并保留结构校验，请求错误与连接错误分流，失败不贴规则 Mock 标签，Demo 文案区分业务数据和模型来源；重启本地代理。现有配置实际请求 17 工具 → HTTP 200 / OK / 0 个工具调用，1991 tokens（仅本次烟测，非全能力验收）；139 单测最终通过、新增 2 E2E 协议 fixture 通过、build/Deno check 通过。去重测试一次偶发失败后重跑通过，未修订其业务逻辑。前述 Runtime 审查项仍未修复；未 commit/push/云端变更。

- **2026-11-14（Runtime 首批执行门控）**：新增结构化停止原因/工具失败判定；Worker 成功证书不再放行工具失败、异常、预算或轮次耗尽，自定义 Evaluator 也不得绕过；显式必需验收条件缺存储时拒绝。每次工具前检查预算/取消、额度用完不额外付费总结、恢复累计旧用量；Event/checkpoint await 与续租错误捕获。backend typecheck 通过，184 测试中 183 通过/1 项真实 Postgres 跳过（新增 15 项回归）。详见 AGENT_REVIEW_2026-11-14.md 新增修复与后续章节。取消在途执行、统一审批、服务端会话/共享存储、完整业务验收与并发仍待完成；浏览器 Demo runChat 尚未统一，现有模型与前端服务未改，未提交/推送/生产变更。

- **2026-11-14（服务端会话历史）**：按用户要求先修会话记忆。TaskStore 新增按 user/session/当前 Task 前序队列号读取历史，复用 Task 已保存输入/最终结果，无新增表或迁移；Worker 真实传入有界历史，不再只传 sessionId，不依赖进程内 session 缓存。失败标记保留，跨用户/会话隔离，checkpoint 不重复拼接，重试不重复轮次；按用户加载可用 UserMemory 画像。新增 7 契约测试+1 PGlite API/Worker/独立 Node 进程磁盘重开测试，backend 191 通过/1 外部 Postgres 跳过，typecheck 与迁移验证 19/19 通过。InMemory 仍不跨重启、画像等其他 Store 仍未共享持久化、旧浏览器历史未自动迁入后台；Demo/模型设置未改，未部署/提交/推送。

- **2026-11-14（聊天执行进度）**：替换单独转圈，显示真实阶段（准备/本地环境检查/等待模型/执行具体工具/总结）、轮次与工具批次、等待秒数及超过 20 秒的长等待提示；不臆测内部思考或伪造百分比。runChat 增可选进度观察器，后台 SSE/断线事件轮询接入；完成/失败清除，切换会话不串状态。新增 4 单测+2 E2E，web 143/143、E2E 14/14、build 通过，桌面与移动端截图已检查。现有模型配置/数据未改，未新增在途取消、未提交/推送。

- **2026-11-14（助手 Markdown 排版）**：根因是助手 content 被纯文本直出，导致星号/列表/表格标记裸露。新增安全 Markdown/GFM 组件，仅助手回复使用，用户原文和已存历史不改；支持加粗/列表/表格/代码，表格手机独立横滚，memo 避免输入时反复解析旧回复。禁原始 HTML/危险链接与图片自动加载。新增 4 单测+1 E2E，web 147/147、全量 E2E 15/15、build 通过，并在当前 5173 入口复测排版 E2E；桌面和手机截图已检查。模型配置未改，无真实付费模型调用、未提交/推送。

- **2026-11-14（会话操作悬停提示）**：侧栏归档/删除/恢复加文字 Tooltip，支持键盘聚焦、Esc 关闭；上方弹出且不拦截相邻按钮，固定占位、放大点击区域。保留二次确认、归档和恢复逻辑，未动用户会话。新增 2 E2E，修正 Markdown 测试等待新消息的竞态，147 单测、17 E2E 与 build 通过；实际截图已检查，5173/8787 返回 200。未提交/推送。
