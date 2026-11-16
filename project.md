# CampusMate · project.md

## 2026-11-15 云端任务恢复与可靠摘要

- 当前分支 `codex/cloud-task-resilience-20261115`；修复真实 PG 建连超时的有界恢复、回滚原错、坏连接/Client error、Worker 存储暂停与空闲认领恢复。显式审阅的纯只读查询可恢复一次，写入和事务不重放，TLS/owner/密钥保持；本机改用原项目 IPv4 Session Pooler，数据库不走 CONNECT。
- 简短信息收集从真实搜索结果读取至多两个来源，再以实际 URL 生成摘要；失败透明记录。新增轻量 summary 阶段，保留研究和复杂任务 high 偏好及真实遥测；补通知赛程与实际举办的时效区分。
- 真实 high 云任务252138ms完成，真实暂停任务在新连接下恢复；最终auto任务174459ms、2次模型/2次工具、26轮询及SSE均通过，保留实际状态未核实。实际重启后读回6条消息/18条事件、模型及密钥解密匹配；夹具已清理、旧失败记录保留。11-16收尾补原子租约暂停与受控时钟回归，最终串行348项为347 pass/0 fail/0 cancelled/1外部数据库skip，类型通过。已重新拉起前端5176、云API/Worker8788并验证认证API为200，不依赖WSL。
- 规格及完整失败/恢复证据见 `docs/specs/cloud-task-resilience.md`、`docs/CLOUD_TASK_RESILIENCE.md`；本轮不push、不合并main，不改旧会话或数据库结构。

## 2026-11-15 Gemma 工具执行回归修复

- 用户报告竞赛收集任务只返回JSON/Gemma工具token，随后超时；已查实前两任务无tool.called却succeeded，第三任务单次180008ms超时。主代理单独修复，分支`codex/model-tool-recovery-20261115`，不push/不合并main。
- 修复独立工具文本解析/一次有界协议修正、未执行指令禁止验收成功；Radeon builtin/BYOK自动适配图像/原生工具/SSE/max_tokens/嵌套思考与单system。设置页移除能力填写，ID自动生成、名称可选。
- 真实API又揭示同index不同ID被拼成web_fetchweb_fetch，以及SSE错误帧被漏读；已修复ID组装、错误分类和DONE终止。补搜索实体相关性/一次短查询回退、已取得正文后的简短摘要阶段、真实来源绑定、带提示的只读抓取恢复；写入失败、用户指定必读来源、预算/取消/幂等保护保留。
- 已用用户授权的真实Gemma识别测试图7319/红色圆形；原始竞赛提示在完整工具清单下5次模型请求、4次工具调用、128824ms正常结束，成功读取高校通知并列出来源，原官网抓取失败透明提示。不将赛前计划日期叙述视为独立事实验收，保留质量风险。
- 后端320项：319 pass / 0 fail / 1外部TEST_DATABASE_URL skip，类型通过；前端219/219及类型/生产构建通过。已确认无排队/运行任务后重启本机8788，postgres/Worker开启，5176=200，认证模型列表200/未认证401，内置Gemma自动能力已生效。主密钥、云数据和旧任务记录保持。
- 详情见`docs/MODEL_TOOL_RECOVERY.md`及`docs/specs/model-tool-recovery.md`。其他Key/端点完整探测、原生其他协议和KV收益仍待真实验收；本次不宣称全模型兼容或所有事实准确。

## 2026-11-15 云端持久化运行接入

- 用户因 WSL 内存占用明确选择复用原云端 Supabase。主代理单独完成，分支 `codex/local-persistent-runtime-20261115`，基于已发布 main d22efc9；本次不 push、不合并 main。
- 已补 PgPool 显式 HTTP(S) CONNECT 与可信 CA 接线，保持 TLS 证书/主机名验证。Windows 原生代理可达；原有云 Auth/账号保持，刷新当前公开 JWKS，服务器主密钥保留在私有配置。
- 云旧 schema 核对并加密备份/解密读回后，登记已有基线并在单事务中应用其余 8 份迁移，共九条原生历史。再次执行 applied=[]，原资料记录未变；36 张 public 表 RLS 开启。
- 已实测真实云的供应商/默认项/会话/消息/任务/文件跨 API 进程重启读回、密钥解密和 API/RLS owner 隔离；诊断只用虚构 key，Worker 暂停期间无模型调用，夹具已清理后恢复正式 Worker。
- 本地 5176 页面、8787 开发代理、8788 Postgres API/Worker 已运行；新增本机忽略入口 `.local/start-campusmate.ps1`，日常不需要常驻 WSL。原有其他 WSL 服务未停止。
- 新增代理回归 4/4、后端类型检查通过；完整后端 293 项为 292 pass / 0 fail / 1 外部 TEST_DATABASE_URL skip。此 skip 独立于上述真实云实测。当前浏览器 Demo，真实账号下保存和 AMD 连通仍待用户登录验收。详见 `docs/CLOUD_RUNTIME_SETUP.md` 和 `docs/specs/cloud-persistent-development.md`。

## 2026-11-15 PR #5 集成审查

- 主代理独立审查同事 PR #5（aa89e3d）并与 T1–T10 基线 6697163 合并，解决 30 处内容冲突。整合分支 `codex/integrate-pr5-main-20261115`，保持双方提交祖先。
- 保留持久会话、加密 BYOK、真实进度、课表和三格式文档；吸收 RepositoryContext、Markdown、确认/撤销、过期视图、群隔离、原子核验 RPC 及本地开发设施；修复工具失败假成功、伪造结果、兼容核验自报 VERIFIED 和时间边界等缺口。详见 `docs/PR5_INTEGRATION_REVIEW.md` 及 `docs/specs/pr5-main-integration.md`。
- 本地后端 288/288、前端 218/218、Demo 浏览器 22/22、Runtime 浏览器 5/5、九份迁移 16/16、两侧类型/生产构建/Function 检查及确定性 benchmark 30/30 通过。外部数据库、真实模型和依赖告警仍按审查记录标明边界。
- PR #6 已通过远端 CI 并以 20389f3 合入 develop，原 PR #5 同步标记合并；Linux PDF 的 AppArmor 问题通过 CI 浏览器定向 profile 修复。另补 Release 作业最小写权限，匹配仓库只读默认 token。完整记录见审查文档。
- 最终版沿 develop→main 发布 PR 交付，main 实际 SHA 和构建清单一起记录。因 GitHub 禁止作者自审，用户明确授权只在合并窗口临时调整审批数，CI/main strict 保持，操作后恢复；PR #6 的 develop 已恢复为 1。

## 2026-11-15 当前实施记录

- 用户已批准 Spec v2（20项验收、10个任务），随后要求召回子智能体，现由主代理单独执行。分支 `codex/campusmate-reliability-experience`；方案见 `docs/specs/campusmate-reliability-and-experience.md`。
- T1共享持久化底座已提交并本地验收（e9d83d4）：七类Postgres Repository、私有机会及子资源RLS、完整迁移清单。
- T2会话画像接线完成本地实现：原子turn与顺序屏障、原始transcript/摘要/身份纠正、审批恢复、UUID映射、owner/session隔离与当前窗口计量。后端218/218、前端104/104、两侧类型、五版本迁移16/16和生产构建通过。详见 `docs/specs/tasks/t2-session-context.md`。
- T3认证模型接入完成：owner级AES-GCM凭证、OpenAI兼容配置、默认/编辑/测试/删除、任务快照及真实Worker路由、配置模型与实际返回分离；开发代理停止新增明文key。完整后端224及最终定向13通过，前端106通过，类型/六份迁移/构建通过。配置见 `docs/MODEL_SETUP.md`。
- T9调用策略完成本地验证：稳定前缀/动态上下文分层、端点能力驱动参数、auto/low/medium/high真实接线、nullable usage、SSE正文/工具分片、统一deadline/retry、截断/预算暂停、大输出artifact引用及非幂等异常保护。后端完整236及最终相关14、前端107通过，类型/迁移/构建通过；真实KV收益和美元费用未知。
- T4执行可视化完成本地验证：真实工具ID/耗时/脱敏来源、流式正文、连续事件订阅及poll补拉、刷新会话续接、审批/预算恢复/取消和有界本地缓存；浏览器开发路径明确恢复边界。后端240/240、前端114/114、两侧类型及构建通过，同时修复通知桥接合并的顺序缺陷。
- T5日历与导入完成本地功能：学期时区/具体日期、单双周/调课源目标、七版本迁移、学校校区生效作息、时间轴/移动日视图、持久预览确认幂等追加、XLSX解码及ICS UTC/夏令时语义；Today接通真实课程和下一项，逾期不计未来七天。后端完整244及最终定向15、前端完整122及最终日期5、类型/迁移/构建通过。详情见T5子规格。
- T6策划书闭环完成本地验证：真实Worker资料→提纲→逐章→检查/一次修订→交付，冻结非空Plan，CP恢复不重做完成章，通用受限文档AST、版本/hash、授权MD下载与React预览。短答、缺章、虚构引用/未解决工具失败不能冒充成功。后端完整253及最终相关8、前端124、类型/构建通过；正文结构检查不等于事实真伪或写作质量证明。
- T10文档能力完成本地验证：通用create/inspect/export、实际MD/DOCX/PDF、导出缓存和字节/源哈希、字体子集修复CJK复制映射；Worker文档工具失败不被模型短答掩盖。后端完整255、前端125，类型/构建通过；DOCX经本机Word与产品PDF各5页逐页检查通过，LibreOffice缺失保留WARN。资源清单见DOCUMENT_RUNTIME.md；云隔离计算只交付评估，不声称已部署。
- T7样板UI完成本地验证：Inbox搜索筛选/排序与双栏预览、移动详情弹层、默认暖白明亮主题与既有暗色偏好；课表1440/768/390明暗浏览器预览，通用边框/暗色日期对比和菜单关闭修正。前端129、类型/构建通过。
- T8本地集成收口完成：后端256/256、前端131/131、七份迁移16/16、两侧类型/构建及10项浏览器用例通过；覆盖身份连续使用、high参数、任务刷新/取消/旧恢复409、BYOK、课表同步和MD/DOCX/PDF真实下载，保存三宽两主题截图。另修复登录数据源切换时机/跨owner缓存、手机预览回焦和查看别周影响今日摘要。详见 `docs/ACCEPTANCE_20261115.md`。
- 当前T1–T10均accepted local；真实模型写作质量/KV收益、外部Postgres/Supabase RLS和实际高校数据未验证。外部DB入口1skip明确未连接；无push、发布或生产操作，CI已接线但未触发远端运行。

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
