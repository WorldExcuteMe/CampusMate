# Handover · 2026-11-20 · CampusMate Agent UI + 路线图

> 给接手的 Agent：先读本文件，再按「启动提示词」执行。仓库：`C:\Users\Asus\CodeBuddy\campusmate-builds\agent-local-workspaces`
> 分支：`feature/agent-local-workspaces`（已推送 origin）。远端：https://github.com/WorldExcuteMe/CampusMate/tree/feature/agent-local-workspaces
> 本文件所在提交之后，分支即可继续开发；**不要重写历史、不要 force push 到 main**。

## 1. 项目定位（不要偏离）

- CampusMate 是**本地优先的 Web Agent**（类似 DeepSeek Harness / Hermes 的开源形态）：用户在自己机器上启动进程，
  浏览器打开 `127.0.0.1`，账号/会话/工作区/文档/密钥留在本机。
- 比赛交付形态（用户 2026-11-20 更正）：**以 Qoder Sites 部署版为主要交付**，本地版作为完整能力补充。
  Qoder Sites 部署版 = 静态前端 + Deno Edge Functions + Sites DB/对象存储 + 平台内置 Qoder 登录 +
  **Qoder Cloud Agents（托管云沙箱，含 Bash/Read/Write/WebFetch/WebSearch/Browser Use/MCP/Memory/Schedules/DeliverArtifacts）**。
  真正的"云上不能做"的只有**绑定用户本机**的能力：本机任意文件/本机终端/本机 QQ 微信数据/离线/本地 PGlite；
  这些属于本地版，云端用"云沙箱文件 + 粘贴通知 + 上传文件"等价替代并在作品帖写清边界。
- 本仓库是 worktree；`C:\Users\Asus\CodeBuddy\qoder比赛` 是原始主工作区（Supabase 旧架构），**不要**把两者混着改。

## 2. 当前状态（2026-11-20 10:40）

### 已完成（本会话）
- 设计系统 v1 + D2/D3/D4/D5：
  - `docs/specs/frontend-design-system.md`（石墨工具风：中性灰阶 + 系统蓝 `#007ACC/#3794FF`，8px 圆角、1px 边框、无渐变/glow）；
  - 全局 token 在 `web/src/globals.css`；基础组件（button/input/card/badge）与 App Shell、对话页、设置页、所有功能页已按系统重排；
  - 对话内工作步骤时间线 `MessageWorkSteps.tsx` + `work-steps.ts`（默认一行摘要，运行中自动展开）；
  - 视觉基线：`web/e2e/visual-system.spec.ts` + `docs/design/visual-baseline/` 16 张截图。
- 架构审计与方案文档：
  - `docs/specs/frontend-agent-ui-api-gaps.md`（后端缺口 Top10）
  - `docs/specs/frontend-agent-ui-audit.md`（web 现状差距）
  - `docs/specs/frontend-agent-ui-dsh-reference.md`（DSH UI 语义）
  - `docs/specs/frontend-agent-ui-consolidation.md`（单窗整合 P1-P4）
  - `docs/specs/local-first-architecture-and-auth.md`（better-auth + PGlite 单数据源 + Qoder PAT/SSO 分析）
- 迁移/评审相关：真实测评走我们 agent + DeepSeek V4 Flash、reasoning=max、360s 超时、冻结快照、标准臂；
  测评目录 `C:\Users\Asus\CodeBuddy\campusmate-builds\acceptance-20261118\external-benchmarks`（OfficeBench 7/9、AppWorld 2/3+3/3、GDPval/HORIZON canary 有环境受限记录）。
- Qoder Sites 事实：站点可用平台内置 Qoder 登录（`/__qoder_auth/start` → `qoder.cn/oauth/authorize` PKCE）；
  Edge Function 401 `login_required`；平台提供 DB/对象存储/AI 限流/600 rpm。

### 验证基线
- web：`node node_modules/typescript/bin/tsc --noEmit` 通过；`node node_modules/vitest/vitest.mjs run` **300 passed**
  （1 个既有环境失败：`attachment-documents.test.ts`，junction node_modules + Vite fs.allow，非代码问题）；`node scripts/build.mjs` 成功。
- backend：`cd backend && node --test --test-concurrency=2`（此前 685 通过/1 跳过，改动后需重跑）。
- 视觉：`node node_modules/playwright/cli.js test e2e/visual-system.spec.ts`（首次需 demo-server，5173）。

## 3. 立即要跑的命令（Windows）

```powershell
# 前端（Demo 模式，无需后端/登录）
cd C:\Users\Asus\CodeBuddy\campusmate-builds\agent-local-workspaces\web
node dev/serve.mjs            # http://127.0.0.1:5173
# 或只预览构建产物：node dev/serve.mjs preview

# 类型/测试/构建
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/vitest/vitest.mjs run
node scripts/build.mjs

# 视觉基线（Playwright）
node node_modules/playwright/cli.js test e2e/visual-system.spec.ts

# 后端（Node 24，type-stripping）
cd ..\backend
node src/main-local.ts        # 本地模式（PGlite + worker，具体端口看启动日志）
node --test --test-concurrency=2
```

环境坑：`npm` 不在 PATH；node 在 `C:\Users\Asus\bin\node.cmd`；GitHub 推送需本地代理
`git -c http.proxy=http://127.0.0.1:7890 push`（直连 schannel 会失败）。PowerShell 替换多行文本优先用
`[System.IO.File]::ReadAllText/WriteAllText` 或 edit 工具，不要用会丢转义的 here-string。

## 4. 下一阶段优先级（按顺序）

### P0 · 本地优先认证与设置（真可用）
1. 抽 `AuthAdapter`：后端去掉"必须 Supabase JWT"；本地模式用 **better-auth 1.7.26**（MIT）+ passkey 插件，
   挂 `/api/auth/*`；PGlite 单数据源（如 adapter 不兼容，auth 表可退化为本地 SQLite，但业务数据仍 PGlite），
   未知 `AuthAdapter` 时启动给出明确提示。
2. 前端登录页改为本地登录（邮箱密码/匿名本地模式/可选 Qoder PAT 绑定）；Supabase 降级为**可选云同步插件**，
   删除运行必需依赖（保留迁移脚本/导出导入）。
3. `settings` 表 + `/v1/settings/{agent,model}`：工作步骤展示、默认模型/思考、权限默认、语言、外观落库；
   前端设置页保存后真实生效（刷新/重启不丢）。
4. 删除 dev-only `X-Session-Owner` 绕过；默认只绑定 `127.0.0.1`；本地 API 校验同源/token；CSRF 检查。

### P1 · 后端/数据库缺失项（前端已提前留 UI）
- 工作步骤事件补强：思考摘要（不落原文，隐私开关）、plan/todo、终端命令与退出码、工具参数/结果预览；
- 上下文估算/分层 breakdown、会话级缓存聚合；模型目录/保存前探测；
- 工作区文件 HTTP API + artifact 预览（侧栏文件树/文档预览依赖）；
- multipart 附件服务（替换 4 张 base64；本地文件 + 清理策略）；
- MCP servers 表 + `/v1/mcp/servers` CRUD；技能注册表 + `/v1/skills`（启停/删除/查看 SKILL.md）；
- 审计事件表（登录、审批、风险工具）、限流/成本护栏。
- 每项都必须：后端 api 测试 + 前端组件测试 + 真实接口（无死按钮）。

### P2 · Qoder Sites 云端版（比赛公开链接，用户强调这是主交付，可前移到 P0）
- 最小 Agent App 验证：Deno Edge Function + Sites DB + 对象存储 + 平台 Qoder 登录；函数里取用户身份、限流/超时/4MB 实测；
- 云端受限工具集：web_search/web_fetch、document_create/inspect/export、云文件、RAG、审批、设置；
- **分步执行器**：每次函数请求 = 1 次 LLM + 一批工具 + checkpoint（30–60s 内），前端自动续跑，长任务可断点；
- 前端 `VITE_RUNTIME=local|cloud`：同一 UI，云端隐藏本地工具入口，显示"演示版边界"；
- 发布：`qoder sites` 构建/发布、public 访问、Secrets、日志/分析。

### P3 · 产品体验与评测
- 3 分钟黄金体验流：群通知→待办/日程；复杂网站取数→脚本校验→文档导出；文档生成→回读→导出；
- 作品帖模板 + 演示视频脚本 + README/架构图 + 本地一键启动（含 Windows bat/ps1）；
- 评测护栏：canary 3 次重复、健康门禁、失败根因分类；CI 跑 backend/web 测试 + 视觉基线。

## 5. 美术/UI 还缺什么（脑洞清单，按价值排序）

1. **品牌识别**：现在只有 Lucide 图标 + 文字 logo。需要一个自己的标（校园/墨/门牌/时间表网格的抽象），favicon、登录页、空状态、演示首图统一。
2. **动效语言**：目前基本静态。建议统一 120/180/240ms + easing：流式光标、工具卡进入/展开、右栏滑入、发送后乐观回显、页面切换淡入；全部可被 `prefers-reduced-motion` 关闭。
3. **Agent 存在感**：运行中应有"正在做什么"的一行 live 状态（例如"正在检索 3/5 · 生成文档"），而不是只有右侧面板；停止/暂停/继续做成 composer 上的明确状态条。
4. **对话画布**：思考行、终端输出卡、审批卡、压缩标记、轮次收尾、产物卡——目前只有工具步骤和正文；需要一屏能读懂"过程+结果"，但默认折叠。
5. **导航增强**：⌘K 命令面板、会话搜索/置顶、从会话跳任务/产物、键盘导航（Esc 停、Enter 发、⌘Enter 换行）；目前只有鼠标。
6. **右栏工作台**：工具卡与消息内步骤视觉统一（同一套卡片语言）、产物预览（md/docx/pdf 内嵌）、上下文环形/分层可视化；现在只是文本列表 + 简单进度。
7. **空状态与首次使用**：现在空状态是两行字。可做"三种起手式"卡片（粘贴群通知/导入课表/让我找机会）+ 本地优先引导（不注册也能用、数据放哪）。
8. **深色完整度**：只截了对话/设置深色。所有页面需要深色基线 + 对比度检查；深色不是简单反色（边框/状态色要单独调）。
9. **移动端**：侧栏抽屉、右栏改底部抽屉、composer 安全区/输入法适配；目前只有一档 390 截图。
10. **设置页信息架构**：分组已对，但表单仍是"字段堆叠"；建议设置行组件（label/desc/控件右对齐）、危险操作独立区、保存状态/未保存拦截。
11. **数据可视化**：成长页/日历/上下文只有数字与表格；可在"成长"做一条时间轴，在"上下文"做环 + 分层条，在"日历"做周视图密度带。
12. **视觉个性**：工具风很稳但略通用。可加入克制的校园元素（纸张/课表网格/印章作为空状态线稿、深色微噪点），不要破坏信息密度。
13. **截图级演示**：首页/作品帖需要"产品截图 + 动态演示"；可做一个 `/demo` 演示模式（预置数据、自动播放黄金流）。
14. **可访问性**：ARIA-live 流式区域、焦点顺序、对比度审计、字体缩放 200%、色弱友好状态（不只靠颜色）。
15. **组件展厅**：内部 `/app/design` 页展示 token/组件状态（按钮/输入/工具卡/状态），保证后续不跑偏。

## 6. 项目整体还缺什么（脑洞清单）

1. **认证/身份**：本地账号 + passkey + 可选 Qoder PAT；云端用 Qoder Sites 内置登录；无账号匿名本地模式。
2. **数据层**：settings/auth/workspace_files/artifacts/mcp_servers/skills/audit 表；迁移版本化；备份/恢复/导出。
3. **Agent 能力**：MCP 客户端、技能系统（SKILL.md 加载/管理）、长期记忆/知识库、计划模式、子 agent（可选）、
   本地模型（Ollama/LM Studio）接入、多模型路由/fallback、成本预算与降级。
4. **工具生态**：邮件/微信/QQ 群摄取（本地）、ICS 日历同步、浏览器自动化（可选）、文档模板、简历/作品集生成。
5. **运行时稳定性**：长任务断点续跑（已有 checkpoint）、工具失败重试/熔断、超时/预算暂停、事件日志回放、
   进程守护/崩溃恢复、自动更新/版本检查。
6. **部署/分发**：一键启动脚本（Windows/macOS）、托盘/开机自启（可选）、Docker（可选）、
   本地端口冲突处理、云同步插件、Qoder Sites 发布流水线。
7. **安全隐私**：本地 API token、CSRF/CORS、工具沙箱、SSRF/路径穿越防护（已有部分）、上传扫描、
   审批策略与风险分级、审计日志、隐私模式（不记录思考原文）。
8. **可观测性**：结构化日志、OTel（可选）、运行诊断页（最近错误/耗时/模型调用）、用户可导出的问题包。
9. **测试/评测**：backend 685+ 测试、web 300 测试、e2e、视觉基线、真实 canary、回归门禁、评测报告页（跑分证据）。
10. **国际化/文案**：中英切换、术语统一（"任务/步骤/产物/审批"）、错误文案给下一步。
11. **协作/多用户**：单机多本地账号隔离、工作区切换、会话共享（导出链接）；云端分享只读演示。
12. **比赛交付**：公开链接、作品帖（问题→方案→技术→验收数据→本地运行说明）、3 分钟视频、GitHub README/LICENSE、架构图。
13. **仓库卫生**：worktree/builds 目录不提交；`web/dist` 产物；提交信息规约；分支保护；依赖升级策略（better-auth 1.7.26 等）。
14. **性能**：长会话虚拟滚动、流式 Markdown 增量渲染、大附件预览、首屏体积（当前 chunk >500KB 警告）、PGlite 冷启动。
15. **产品闭环**：从"通知→机会→核验→行动→成长"的完整链路数据打通；目前各页数据已有，但跨页联动/回写还不完整。

## 7. 约束与偏好（必须遵守）

- 所有 UI 控件必须真实可用；后端未就绪的能力**隐藏或标注**，不做死按钮。
- 视觉遵循 `docs/specs/frontend-design-system.md`：不引入渐变/glow/新彩色系；新页面先看 token 与页面层级规范。
- 每轮改动：`tsc` + 相关测试 + 全量 web 测试 + build；后端改动跑 backend 测试；UI 改动跑视觉基线。
- 提交：feature 分支、conventional commits、不 `git add -A`；中文汇报，给证据（测试数/截图路径/提交号）。
- 外部测评：真实测评必须走我们的 agent + DeepSeek V4 Flash（reasoning=max、360s、冻结快照）；不把 mock 当证据；
  canary 3 次重复 + 失败根因；端点 >60s 健康门禁则推迟。
- 推送：`git -c http.proxy=http://127.0.0.1:7890 push`；不要提交密钥/`.env`；密钥服务端 AES-256-GCM。
- 用户偏好：独立执行、少问重复问题；交付要"能点开、能运行"，不是只给方案。

## 8. 启动提示词（直接复制给接手的 Agent）

```
你是 CampusMate 项目的接任 Agent。仓库：C:\Users\Asus\CodeBuddy\campusmate-builds\agent-local-workspaces，
分支 feature/agent-local-workspaces（已推送 origin）。工作区可能还有未提交改动；先 git status / git log 查看。
先读 docs/specs/handover-2026-11-20-agent-ui-and-roadmap.md、frontend-design-system.md、
local-first-architecture-and-auth.md、frontend-agent-ui-consolidation.md，再开始。

产品定位：本地优先的 Web Agent（类似 DSH/Hermes），账号/会话/工作区/密钥都在本机；比赛需要 Qoder Sites
公开演示版（平台内置 Qoder 登录 + Deno Edge Function + Sites DB/对象存储 + Cloud Agents），云端只跑受限工具。

当前状态：web tsc 通过、300 测试通过（1 个 pdfjs 既有环境失败）、build 通过；设计系统与所有页面第一轮视觉统一已完成；
视觉基线在 docs/design/visual-baseline/；对话页已有 work-step 时间线。接下来按优先级：
P0 完成本地优先认证（better-auth 1.7.26 + PGlite 单数据源 + AuthAdapter 抽取 + 本地登录页 + 删除运行必需 Supabase）
与 settings 表/API（工作步骤/默认模型思考/权限/语言/外观落库并生效）。
P1 按 docs/specs/frontend-agent-ui-api-gaps.md 补后端缺口：工作步骤事件、上下文 breakdown、模型探测、
工作区文件 API、multipart 附件、MCP/技能 CRUD、审计/限流。
P2 做 Qoder Sites 最小 Agent App 验证（/__qoder_auth/start、Edge Function 用户身份、DB/对象存储、函数超时/限流），
再实现云端分步执行器 + 双模式 UI。
P3 补黄金体验流、作品帖、演示视频脚本、README/一键启动。
UI 剩余：深色基线/移动端抽屉、成长与任务页 Tabs/状态中文化、composer 降噪、⌘K、右栏产物预览、
空状态与首次使用引导、品牌标识与动效语言。遵守 docs/specs/frontend-design-system.md，不引入新彩色系。

验收：每轮 tsc + 相关测试 +（后端改动）backend node --test + full web vitest + build；UI 改动跑
node node_modules/playwright/cli.js test e2e/visual-system.spec.ts 出 before/after 截图。
提交用 conventional commits，只 add 明确文件；推送通过 git -c http.proxy=http://127.0.0.1:7890 push。
外部测评规则：真实测评走我们 agent + DeepSeek V4 Flash(reasoning=max, 360s, 冻结快照)，canary 3 次，
不把 mock 当证据。遇到阻断先记录并继续可做的部分，最终用中文汇报：改了什么、证据、下一步。
```

## 11. Qoder Sites 部署版能力矩阵（2026-11-20 更正）

用户强调"我指的是 Qoder Sites 上部署的"。此前说"完整 Agent 不能部署到 Sites"需要更正为：
**我们自己的 Node Worker 不能原样部署，但 Qoder Cloud Agents 提供了托管云沙箱**，因此部署到 Sites 的应用可以拥有真实
Agent 运行能力（在 Qoder 云沙箱里，而非访客电脑上）。

| 能力 | Qoder Sites 部署版 | 说明 |
|---|---|---|
| 静态 UI / 路由 / 设计系统 | ✅ | Sites 静态托管 |
| 平台内置 Qoder 账号登录 | ✅ | `/__qoder_auth/start` → `qoder.cn/oauth/authorize`（PKCE），Edge Function 未登录返回 401 `login_required` |
| 应用数据/设置/会话元数据 | ✅ | Sites DB（函数里访问） |
| 对象存储/产物下载 | ✅ | Sites 对象存储；Cloud Agents `DeliverArtifacts` 产出下载链接 |
| Agent 运行/长任务/SSE | ✅ | Qoder Cloud Agents：Agent + Environment + Session，SSE 事件流，scheduled/webhook 也可用 |
| 云沙箱文件/云终端 | ✅ | Cloud Agents 内置 Bash/Read/Write/Edit/Glob/Grep（在云容器 `/data` 里，不是用户电脑） |
| Web 搜索/抓取/图片搜索 | ✅ | WebSearch/WebFetch/ImageSearch/ImageGen |
| 浏览器自动化 | ✅（Beta） | `browser_toolset_20260714` + `x-qoder-beta: browser-use-2026-07-14` |
| MCP 工具 | ✅ | Cloud Agents MCP 连接器；Sites 函数侧也可接 HTTP MCP |
| 记忆/技能 | ✅ | Memory Stores / Agent Skills |
| 文档生成/导出 | ✅ | 沙箱写文件 + DeliverArtifacts；前端只负责预览/下载 |
| 群通知导入（QQ/微信本机数据） | ❌（部署版） | 云端无法读访客本机群数据；用"粘贴通知/上传截图"替代，保留本地版能力 |
| 用户本机任意文件/本机终端 | ❌（部署版） | 云沙箱只能操作云文件；本地版可用 |
| 离线/本机 PGlite/本机密钥 | ❌（部署版） | 本地版特性；云端密钥放 Sites Secrets |
| 自定义 DeepSeek 模型 | ⚠️ | Cloud Agents 用其模型配置；我们的 provider 配置在本地版生效。云端如需 BYO Key，可在 Sites Secrets/DB 加密存储，但 Agent 运行时仍是 Cloud Agents（或 Edge Function 自己跑循环，受函数时限约束） |

### 推荐的 Qoder Sites 架构

```
Qoder Sites 静态前端（VITE_RUNTIME=cloud，复用同一套 UI/设计系统）
   │ 内置 Qoder 登录；/functions/v1/app 同源 API
Edge Function（Deno）
   ├─ 校验平台登录身份 / 会话与设置（Sites DB）
   ├─ 创建/查询 Cloud Agents Agent、Environment、Session
   ├─ 代理 SSE 事件流 → 前端（工具调用/思考/产物）
   └─ 产物：DeliverArtifacts → 对象存储/下载链接
Qoder Cloud Agents（托管）
   ├─ 云沙箱：Bash/Read/Write/Edit/Glob/Grep、/data 文件
   ├─ WebSearch/WebFetch/ImageSearch/ImageGen/VideoGen、Browser Use(Beta)
   ├─ MCP 连接器、Memory Stores、Skills、Schedules/Webhook
   └─ SSE：thinking / message / tool / artifact / status
```

### 部署版产品形态（比赛用）

- 页面入口：Qoder 账号一键登录 → 首页/工作台 → 3 分钟黄金流（粘贴通知→整理待办→生成文档→下载产物）；
- 数据边界说明：页面标注"演示版运行在 Qoder 云端沙箱；本机文件/群数据请使用本地版"；
- 本地版仍保留完整能力（本机文件/终端/QQ 微信群/离线），作品帖用视频展示，并附一键启动说明。

### 实施顺序（部署版优先）

1. Qoder Sites 最小 Agent App 技术验证：登录、Edge Function 读取用户身份、Sites DB、云函数超时/流式/限流、Cloud Agents 连通性；
2. 用 Qoder Cloud Agents 跑通一条真实黄金流（粘贴通知→Cloud Agent 整理→Write 文档→DeliverArtifacts→前端下载）；
3. 前端 `VITE_RUNTIME=cloud`：复用对话/工作步骤/上下文 UI，数据源换成 Sites API + Cloud Agents SSE；
4. 补齐设置/会话/产物/审批映射；作品帖 + 视频 + 公开链接；
5. 本地版（better-auth/PGlite/本机工具）作为第二形态继续完善。

## 12. 启动提示词 v2（以 Qoder Sites 部署版为核心）

```
你是 CampusMate 项目的接任 Agent。仓库：C:\Users\Asus\CodeBuddy\campusmate-builds\agent-local-workspaces，
分支 feature/agent-local-workspaces（已推送）。先 git status/log，读 handover-2026-11-20-agent-ui-and-roadmap.md
（含 Qoder Sites 部署版能力矩阵）与 frontend-design-system.md，再开始。

核心交付：**Qoder Sites 部署版**（比赛公开链接），不是只做本地版。
架构：Sites 静态前端 + Deno Edge Functions + Sites DB/对象存储 + 平台内置 Qoder 登录
（/__qoder_auth/start）+ Qoder Cloud Agents 托管云沙箱（Bash/Read/Write/Edit/Glob/Grep/WebSearch/WebFetch/
ImageGen/VideoGen/Browser Use(Beta)/MCP/Memory/Skills/DeliverArtifacts，SSE 事件流）。
云沙箱能力可以在部署版真实运行；不能上云的是"用户本机数据/本机终端/离线/本地 PGlite/QQ微信本机数据"，
这些保留本地版并在作品帖说明用本地版/视频展示。

当前状态：web tsc 通过、300 测试通过（1 个 pdfjs 既有环境失败）、build 通过；设计系统与所有页面第一轮视觉统一完成；
视觉基线 docs/design/visual-baseline/；对话页已有 work-step 时间线。

优先级：
P0 部署版技术验证 + 黄金流：Sites Agent App 最小闭环（Qoder 登录→Edge Function→Sites DB→Cloud Agents Agent/
Environment/Session→SSE→Write 文档→DeliverArtifacts→前端下载），确认函数超时/流式/限流/并发；
P1 前端 VITE_RUNTIME=cloud 双模式：复用对话/工作步骤/上下文 UI，数据源切 Sites API + Cloud Agents SSE；
设置/会话/产物/审批映射；云端隐藏本地专属入口；页面标注演示边界；
P2 深化部署版 Agent 能力：MCP、Memory、Skills、Browser Use、Schedules/Webhook、多智能体（按比赛需要）；
P3 本地版（better-auth/PGlite/本机工具）与作品帖/视频/一键启动并行推进。

约束：Qoder Sites 函数不能常驻，长任务交给 Cloud Agents Session（SSE/轮询），不要让 Edge Function 自己跑长循环；
API Key/PAT 放 Sites Secrets，前端不可见；平台登录态由 Sites 托管；遵守 docs/specs/frontend-design-system.md。
验收：tsc + web vitest + build + Playwright 视觉基线；后端改动跑 node --test。提交 conventional commits，
不要 git add -A；推送用 git -c http.proxy=http://127.0.0.1:7890 push。中文汇报：改了什么/证据/下一步。
```

## 13. P0 接任核实（2026-11-20，首轮记录）

后续验证状态见第 14 节，Sites 解阻路径见第 15 节；本节保留首轮证据，pdfjs 环境问题及 Deno 验证缺口已在第二轮解决。

- 接任起点：`feature/agent-local-workspaces` / `bd99c7a`，工作树干净；已按顺序阅读五份指定文档。
- 本轮重新运行 web `tsc --noEmit` 与 `node scripts/build.mjs` 均通过；构建仍有 500 kB chunk 警告。全量 Vitest：**372 项通过，57 个文件通过，1 个文件导入失败**；失败仍为 `attachment-documents.test.ts` 的 pdfjs worker 经 node_modules junction 超出 Vite 文件访问范围（`Denied ID ...pdf.worker.min.mjs?url`）。新增 Cloud Agents 契约测试 62 项、探针控制流测试 10 项全部通过，均为 fixture，不是真实云端证据。
- 官方 Sites 文档确认 Agent App 与 DB/存储能力，但创建与发布入口是 Sites 面板；本机 `qoder --help` 为 IDE 启动器，没有 `sites` 子命令，不能照旧文档假设 CLI 发布可用。
- 当前会话未提供 Sites 发布、DB、Secrets 工具，也没有已确认的函数身份/数据库 SDK 契约；进程环境未配置 `QODER_ACCESS_TOKEN` / `QODER_PAT`。没有读取 IDE 登录凭据，也未进行云端资源创建或付费调用。
- Cloud Agents 官方契约已核实：`/api/v1/cloud`；创建 Session 绑定 Agent 版本与 Environment；以 `events` 数组提交 `user.message`；SSE 使用 `Last-Event-ID` 重放；历史事件使用 `page` / `next_page`；产物事件为 `agent.artifact_delivered`，以 `file_id` 请求 `/files/{file_id}/content` 获得限时 `url` / `expires_at`。
- 官方示例地址为 `https://api.qoder.com`；国内账号的区域地址与可用性仍需实际配置确认，不猜测区域域名，不把 PAT 发送到未确认端点。
- `idle` 不等于产物验收成功，必须核验工具结果、交付事件与下载内容；`rescheduling` 仍属于当前轮次，不重发消息。`agent.thinking` 没有正文，不生成虚构思考摘要。
- 用户已授权目标 worktree 写入，现已成功落盘；不改原始 `qoder比赛` 仓库。仍需 Sites 上下文，在 Sites Secrets 配置凭据并接好平台身份和 owner 隔离后，才能做真实黄金流及超时/并发/限流实测。契约测试不能代替这些验收。
- backend 回归：`node --test --test-concurrency=2`，**685 通过、0 失败、1 跳过**（未配置隔离 `TEST_DATABASE_URL`）；耗时约 70 秒。本轮未改 UI，未重拍视觉截图；没有可用 Deno 命令，尚未进行 Deno 原生运行验证。
- 参考：[Sites](https://docs.qoder.com/qoder/sites)、[Cloud Agents 快速开始](https://docs.qoder.com/cloud-agents/quickstart)、[Session 事件](https://docs.qoder.com/cloud-agents/api/sessions/events/list)、[产物下载](https://docs.qoder.com/cloud-agents/api/files/download)。

### 本轮代码与运行入口

- `web/functions/cloud-agents.ts`：服务端 REST/SSE 传输；Environment、最小通知 Agent、固定版本 Session、消息、历史分页、取消和产物链接。只开放 `Read/Write/DeliverArtifacts`，没有向沙箱注入 PAT；禁止重定向，过滤私密 Session 字段，写请求失败不自动重发。
- `web/functions/cloud-events.ts`：UTF-8 跨块解析、LF/CRLF/CR、heartbeat、帧大小限制及半帧断线处理；提前结束消费会释放 reader。`agent.thinking` 不生成正文。
- 单连接默认 25 秒，调用方携带最后完整事件 ID 重连；这是应用侧保护值，**不是 Sites 平台超时的实测结果**。连接关闭不取消 Cloud Agent，显式取消走 Session cancel。
- `web/scripts/probe-cloud-agents.mjs`：Node 24 技术探针，默认只读 `--check`；显式 `--run` 才创建独立 Environment/Agent/Session 并消耗额度。探针本身不放进 Edge Function，其 360 秒监听循环不代表在 Edge 中运行 Agent 循环。
- 探针检查成功的 Write/Read/DeliverArtifacts 工具结果、`end_turn`、真实交付事件、限时链接、下载字节数、Markdown 与 SHA-256；不打印原文、PAT、工具参数或签名 URL。失败后请求取消本次新建 Session，保留资源和 ID 供核查，不自动删除；成功也保留资源，后续由管理员在控制台管理。
- 新增文件均未接入浏览器或 `functions/runtime.ts`。旧的 Supabase/LLM 路由保持原样，**尚未新增 Sites 公开 API、登录、数据库表或前端云模式**，避免在身份/owner 隔离未知时暴露账号级 Cloud Agents API。

在 `web` 目录、仅服务端进程中配置 `QODER_ACCESS_TOKEN` 或 `QODER_PAT`（不要在聊天中粘贴密钥，不写入 `VITE_*`）：

```powershell
node scripts/probe-cloud-agents.mjs --help
node scripts/probe-cloud-agents.mjs --check
# 以下会真实创建云资源并消耗额度；默认输入是明确标记的虚构测试通知。
node scripts/probe-cloud-agents.mjs --run
# 或使用自行提供的 UTF-8 通知文件，最大 64 KiB。
node scripts/probe-cloud-agents.mjs --run --notice C:\path\notice.txt
```

本轮实际执行的是 `--check`，结果：`status=blocked`、`error=cloud_token_missing_or_invalid`、`liveAttempted=false`、`sitesVerified=false`。没有创建云资源，没有获得公开部署链接，没有完成真实黄金流；没有进行外部测评。

### 下一步接入门禁

1. 在带 Sites 能力的任务上下文中取得真实发布、身份、DB 和 Secrets 接口；确认账号所在区域的 Cloud Agents 地址和权限。当前客户端仅接受已核实的 `https://api.qoder.com`，其他区域须先补官方依据与测试。
2. Sites 函数使用可信平台身份，落一张 owner 隔离的 Session/运行映射表；DB 和身份均缺省拒绝访问，不能信任浏览器传入的 userId/Session ID。完成这些后才把适配器接入 `/functions/v1/app`。
3. 先做管理员真实探针，再做 Sites 登录→DB→Session→SSE→产物预览/下载；两者分开记录证据。实测函数断流重连、长任务、并发冲突、限流与产物链接有效期后再进入 P1 UI 接线。

## 14. P0 Edge 接入层与原生验证（2026-11-20，第二轮）

### 已落地代码（仍未挂载生产入口）

- 新增 `web/functions/sites-app.ts` / `createSitesApp`。缺少可信身份、持久化存储、全局额度、Cloud Agents 客户端、固定 Agent/Environment 或站点 Origin 中任一项时，受保护 API 返回 `503 sites_not_configured`；没有匿名收费回退和内存 DB 回退。
- 身份从注入的可信平台适配器取得，不读取猜测的 `X-Qoder-*` 身份头，也不接受浏览器提供 owner/Agent/Environment。未登录返回 `401 login_required`；站点 Origin 检查独立于来访 Host，拒绝跨站读写。
- 运行以 `(owner, requestId)` 绑定正文 SHA-256；创建与发送拆成两个短请求。必须由 Sites 存储实现原子 reserve 与 state CAS；重复请求不重复执行，同键不同正文冲突，响应丢失后进入 `uncertain`/保留 `sending`，不自动重放收费操作。
- 创建/发送前后持久化状态失败时不声明成功；已取得的 Session ID 尽可能保留用于对账。`creating/sending/uncertain` 的恢复需要核对真实 Cloud Agents 状态，不能以租约过期为由重新执行。
- 事件历史与 SSE 都先核对 run owner；对外不暴露账号级 Session ID、工具参数/结果正文、思考原文、上游错误正文或未知载荷。消息预览有界，裁剪时返回 `contentTruncated=true`。
- SSE 每请求仅代理一条上游连接，不自动续跑 Agent；保留事件 ID，断流产生不带 ID 的 `stream_interrupted` 信号，取消订阅释放上游但不取消云端任务。显式取消先封住再次发送入口，再请求平台取消。
- 产物链接只能从当前用户 Session 的 `agent.artifact_delivered` 事件兑换，不能仅凭账号级 file ID 下载别人的文件。查询一次历史页，超出第一页时调用方提供该事件所在页的游标，不在 Edge 遍历全部历史。
- `run.state=cancelled` 表示应用发送入口已封住；实际 Agent 是否已停止仍读取 `session.status`，不能把取消请求回执当作完成。

### 待平台接入的 HTTP 契约

根路径为 `/functions/v1/app`，当前仅由导出的 handler 实现，没有改动 `functions/runtime.ts` 或发布路由：

| 路径 | 用途 |
|---|---|
| `GET /health` | 配置状态；`deploymentVerified=false`，不是平台健康证明 |
| `GET /me` | 已验证用户身份 |
| `POST /runs` | `{requestId, notice}` → 创建绑定的 Session，不发消息 |
| `POST /runs/:id/message` | `{notice}` → 同哈希正文只发送一次 |
| `GET /runs/:id` | 应用运行状态 + 平台 Session 状态 |
| `GET /runs/:id/events?page=...` | 单页安全事件 + `nextPage` |
| `GET /runs/:id/stream` | `Last-Event-ID` 重连；下游事件名 `cloud_event`，JSON 中保留原始事件 type |
| `POST /runs/:id/cancel` | 封住发送后请求取消，可显式重试取消 |
| `GET /runs/:id/artifacts/:fileId?page=...` | 校验当前会话交付记录后换取限时下载链接 |

**存储与配额只有接口契约，没有 Sites DB 实现或建表迁移**。测试使用明确标记的内存 fixture，仅证明应用控制流；不能据此宣称平台持久化、多用户登录、跨实例限流或云端黄金流通过。`reserve` 的实际实现必须原子执行唯一键、请求/并发额度与插入，`transition` 必须以 owner/id/旧 state 约束更新。

### 最新验证结果

- web TypeScript：`tsc --noEmit -p tsconfig.json` 通过；为 Deno 源文件的显式 `.ts` 导入开启 `allowImportingTsExtensions`，继续保持 `noEmit`。
- web 全量 Vitest：**59 个文件、416 项全部通过，0 失败**。其中本轮 Edge 契约测试 40 项，前轮 Cloud Agents/探针测试 72 项。
- pdfjs 原有失败已修复：Vitest 内的 Vite 会同时检查真实文件及带 `?url` 路径；`vitest.config.ts` 仅增加真实 pdfjs `build` 目录的访问许可，不修改生产 Vite 配置、不关闭文件系统安全检查、不 mock 掉 worker URL。原文件 4 项测试全部执行并通过。
- 构建：`node scripts/build.mjs` 成功，仍有现存 500 kB chunk 提示。未修改 UI，没有新增视觉截图。
- Deno 2.9.6：现有函数入口、本地函数入口、新 Edge handler 均 `deno check` 通过；**5 项原生 Deno 测试通过**（无网络和环境变量权限）。修复了 `document` 标识符在 Deno 默认类型库中不存在的问题。
- backend：本轮重新执行 `node --test --test-concurrency=2`，**685 通过、0 失败、1 跳过**，约 81 秒；未配置隔离 PostgreSQL 的用例依然跳过。
- `git diff --check` 通过。没有提交或推送，基点仍为 `bd99c7a`。
- 当前 PATH 的 `npm` 包装器返回路径不存在；`npx` 可用。实际 Deno 验证命令如下，package.json 也已添加相应脚本：

```powershell
npx --yes deno@2.9.6 check functions/index.ts dev/function-local.ts functions/sites-app.ts
npx --yes deno@2.9.6 test functions/sites-app.deno.test.ts
```

### 剩余真实阻断

继续执行时复核：当前 MCP 列表仍无 Sites 发布/DB/Secrets 工具，浏览器 MCP 连接超时，进程仍未配置 PAT。未读取 IDE 私有凭据，未创建云资源，也没有公开部署链接。下一步必须在带 Sites 能力的任务上下文取得平台身份/DB/Secrets 契约，完成持久化与额度适配，再挂载上述 handler 和跑真实登录→通知→文档→下载闭环。**第三轮已找到并验证官方独立 CLI 路径，详见下一节，不必继续等待 IDE 出现 Sites MCP。**

## 15. Sites 缺口的官方解决路径（2026-11-20，第三轮）

### 更正与实际证据

- 此前仅检查 PATH 中的 `qoder`（Qoder IDE 启动器），不足以判断独立 Qoder CLI 的 Sites 能力；“只能通过 Sites 面板”不是完整结论。
- [官方 CLI Sites 文档](https://docs.qoder.com/zh/cli/sites)明确提供独立 CLI 的交互式 Sites 工作流、`/sites` 面板及 `qoder sites` 操作接口。它们属于独立 CLI，不能把 IDE 启动器当作同一个命令。
- 本机已通过官方 npm 兼容包运行独立 CLI **1.1.93**，没有替换 IDE 启动器或修改系统 PATH。
- `sites operations` 实际成功列出 **32 项操作**；`sites describe get_context`、`sites describe get_database_schema`、`sites describe prepare_site` 均取得真实输入 Schema。
- `sites list` 实际失败为 `sites_auth_required` / `No credential was supplied`。这证明操作接口存在，但本次独立 CLI 还未取得登录凭据，**不是已登录、已连接站点或已部署**。
- 进程中的 `QODER_PERSONAL_ACCESS_TOKEN` 也未设置。未读取 CLI/IDE 私有认证文件，未手工构造会话身份，未调用发布、建表、Secret 写入等操作。

### 一次性启用步骤

1. 在自己的 PowerShell 中执行下面的官方 CLI 登录命令，按引导在浏览器中登录与目标 Sites 相同区域的账号。该步骤不能以聊天授权代替真实登录。
2. 登录后使用站点列表核对账号和目标站点；如列表为空或权限不足，不自动新建替代站点。原请求已要求的最小验证站点可按官方会话流程创建，避免覆盖既有项目。
3. 在目标 worktree 启动同一个 CLI 的交互会话，使用 `/sites` 或自然语言进入内置 Agent App 流程。让流程取得平台上下文、数据库 Schema 与官方函数模板，复用本仓库的接入层。

```powershell
npx --yes --package @qoder-ai/qodercli@1.1.93 -- qoder login
npx --yes --package @qoder-ai/qodercli@1.1.93 -- qoder sites list
npx --yes --package @qoder-ai/qodercli@1.1.93 -- qoder --cwd "C:\Users\Asus\CodeBuddy\campusmate-builds\agent-local-workspaces"
```

官方推荐原生安装器；这里用仍受官方支持的 npm 兼容入口避免与 IDE 命令重名。已验证的是公开 npm 包，国内/专有环境须以登录后的官方运行上下文为准，不能擅自回退到另一服务区域。

### 三类身份不能混淆

| 层次 | 解决方式 | 不可替代的边界 |
|---|---|---|
| 开发者管理 Sites | 独立 CLI 浏览器登录，或标准 `QODER_PERSONAL_ACCESS_TOKEN` | IDE 登录不等于独立 CLI 已取得登录凭据 |
| 网站访客登录 | Sites 官方函数模板/运行契约中已验证的用户身份 | 不能信任浏览器提交的 userId 或自造身份头 |
| Edge 调用 Cloud Agents | 同区域 PAT，或组织 Service Account Key 换取 `qca.access` SAT；仅放服务端 Secrets | CLI 浏览器登录不会自动把长期 API 密钥注入部署函数 |

- PAT 官方获取说明：[CLI 认证](https://docs.qoder.com/cli/authentication)、[Cloud Agents 认证](https://docs.qoder.com/cloud-agents/api/conventions/authentication)。公开版文档链接是 `https://qoder.com/account/integrations`；国区使用对应区域的官方控制台，不跨区域发送凭据。
- 本项目探针与客户端当前读取 `QODER_ACCESS_TOKEN` / `QODER_PAT`；CLI 标准 PAT 环境变量为 `QODER_PERSONAL_ACCESS_TOKEN`，两者不是自动同步的配置。不要把密钥写入命令参数、聊天、源码或 `VITE_*`。
  **更正（2026-11-20）**：手工创建/粘贴 PAT 不能解除 Sites 部署阻断，也不应作为恢复步骤；请走官方 CLI 登录与平台托管凭据，详见第 16 节。
- `/sites` 面板提供只写不可回读的 Secrets 管理。若平台 Agent App 流程已经提供托管调用凭据，先核实其真实接口再适配；公开文档不能证明本账号已经自动配好凭据。

### 登录后如何挂载现有代码

- 在正式 Sites 会话里读取 `get_context` 返回的产品、区域、环境及 Cloud Agents origin；原客户端仅允许已核实的公开地址，国区须依据该可信上下文补配置和测试，不能临时关掉端点校验。
- 由官方 Agent App 流程取得身份/数据库接入模板，实现 `createSitesApp` 的 `authorize`、`runs`、`allowRequest`。只有真实存储能满足唯一键/CAS 与跨实例额度，才挂到函数 `index.ts`。
- 已取得的 `prepare_site` Schema 明确支持 `functionDirectory`（包含 `index.ts`）、`databaseAccess=read_write`、`secretNames`；数据库依赖需要同项目的 `schemaRef`。这说明函数可以随静态站点交付，不需要伪造 Vite 代理为生产后端。
- 建表、草稿准备、Secrets 与发布由官方会话工作流编排；不手写 `.qoder.site`，不伪造 `--session`/`schemaRef`/确认值。公开发布须走平台确认，然后读取发布终态和实际 URL。
- 若使用个人 Free 方案，官方文档说明不支持数据库/存储；Teams/Enterprise 不支持组织外公开链接。当前账号方案未知，登录后需核查，不能提前假设比赛公开发布权限可用。

本轮只进行了工具验证和交接更正，应用代码与上一轮 416 项 web 测试通过的版本一致。当前下一项真实阻断已明确为：**完成独立 CLI 的账号登录，然后核查站点上下文与部署函数所用凭据**。

## 16. 恢复点与事实更正（2026-11-20，第四轮）

> 本节为追加恢复点；除此以外仅对第 15 节"手工 PAT"表述做一处更正，其余历史记录保持原样。
> 事实来源：本轮 `.local/sites` 下的四份回执与主会话验证输出；本节结论以这些回执及验证输出为准。

### 16.1 本轮已确认

- 当前 CLI 已登录且托管 PAT 就绪；恢复时先取只读回执与 `get_context`、`list`，认证失效才重新登录，不重复创建站点或资源。
- Sites DB：**两张私有表已 applied**。
- P0：**代码与打包完成**。
- 主会话验证（全部通过）：
  - web `tsc --noEmit` 通过、`node scripts/build.mjs` 通过；
  - web Vitest **451 通过**；
  - Deno **5 通过**；
  - Playwright **9 通过**；
  - backend `node --test --test-concurrency=2` **685 通过、1 跳过**。
- 完整 action `0f2fe3a8-04f2-46a0-ab75-966cbb2e4777` 的 `prepare` 返回 **`sites_invalid_request`**；**没有部署，没有发布**。
- "schema 版本范围不兼容"**只是未证实推测**，不是已确认根因，不得写入结论，也不得据此修改配置。
- 版本事实：**官方 npm 包与原生 manifest 最新版本均为 `1.1.93`**。已是官方最新，没有可升级版本，也没有换版本解阻的空间。

### 16.2 截图清单（证据）

Playwright **9 项通过** = `web/e2e/visual-system.spec.ts` **7 项** + `web/e2e/sites-p0.spec.ts` **2 项**。运行输出在 `web/test-results/visual/` 与 `web/test-results/sites-p0/`；`docs/design/visual-baseline/` 仅为历史基线，本轮未归档。

- 对话页：`agent-light-1440.png`、`agent-light-1440-steps.png`（步骤摘要存在时才生成）、`agent-light-1024.png`、`agent-dark-1440.png`、`agent-dark-1440-steps.png`、`agent-dark-1024.png`
- 设置页：`settings-light-1440.png`、`settings-dark-1440.png`
- 功能页（浅色 1440）：`dashboard-light-1440.png`、`inbox-light-1440.png`、`calendar-light-1440.png`、`radar-light-1440.png`、`daily-light-1440.png`、`trust-light-1440.png`、`growth-light-1440.png`、`profile-light-1440.png`
- 入口页（浅色 1440）：`landing-light-1440.png`、`login-light-1440.png`
- 移动端：`agent-light-390.png`
- Sites P0（本轮）：`web/test-results/sites-p0/{before-desktop,after-desktop,after-dark,after-mobile}.png`

复现命令：

```powershell
cd C:\Users\Asus\CodeBuddy\campusmate-builds\agent-local-workspaces\web
node node_modules/playwright/cli.js test e2e/visual-system.spec.ts e2e/sites-p0.spec.ts
```

### 16.3 恢复路径（按顺序，不绕过校验）

1. 当前已登录且托管 PAT 就绪：先取只读回执并执行 `qoder sites list`、`get_context`，核对账号区域与目标站点；只有认证失效（如 `sites_auth_required`）才重新走官方 CLI 浏览器登录，不重复创建站点或资源。不要手工 PAT。
2. 在官方 `/sites` 会话中读取 `get_context`、`get_database_schema`、`prepare_site` 的真实输入 Schema，按其字段组装参数。
3. 对照 `prepare_site` Schema 检查本次请求（如 `functionDirectory`、`databaseAccess`、`secretNames`、`schemaRef` 等）。`sites_invalid_request` 表示请求不满足 Schema，不是网络或额度问题。
4. 修正输入后重试；保留 action id 与被拒请求体（脱敏），**不得改 CLI 源码、打补丁或加包装层绕过校验**。
5. 仅在 `prepare` 通过后执行部署/发布，并读取终态与实际 URL 作为唯一验收证据；在此之前不得宣称已部署或可公开访问。
6. 若仍为 `sites_invalid_request`，记录真实 Schema 与请求差异并交由平台工作流；**不得把"schema 版本范围不兼容"当作结论**。

```powershell
# 已登录时：只做只读核对，不重复创建
npx --yes --package @qoder-ai/qodercli@1.1.93 -- qoder sites list
npx --yes --package @qoder-ai/qodercli@1.1.93 -- qoder sites describe prepare_site
# 仅在认证失效（sites_auth_required）时执行
npx --yes --package @qoder-ai/qodercli@1.1.93 -- qoder login
```

### 16.4 禁止事项

- 禁止私改 Qoder CLI（源码/补丁/包装/伪造子命令）绕过校验。
- 禁止降级数据库或篡改 schema 版本范围来规避校验。
- 禁止手工构造 PAT、session、`schemaRef`、确认值或身份头。
- 禁止把未证实推测写成根因；禁止跨区域发送凭据。
- 禁止在 `.local/sites` 结果与主会话验证之外宣称"已部署/已发布/已可公开访问"。

### 16.5 更正：手工 PAT 说法

更正第 15 节及此前口径：**"手工配置/粘贴 PAT"不是 Sites 部署的解阻路径**。应通过官方 CLI 浏览器登录取得开发者会话，再由 Sites 平台工作流托管函数调用所需凭据。`QODER_PERSONAL_ACCESS_TOKEN`（CLI 标准）与探针读取的 `QODER_ACCESS_TOKEN` / `QODER_PAT` 不是同一配置，不能互相替代或手工拼接。当前阻断是 `prepare` 的 `sites_invalid_request`，与 PAT 是否存在无关。

### 16.6 恢复入口文件

- 交接文档：`docs/specs/handover-2026-11-20-agent-ui-and-roadmap.md`
- Sites 接入层：`web/functions/sites-app.ts`、`web/functions/sites-database.ts`、`web/functions/sites-production.ts`、`web/functions/sites-config.ts`
- 构建/探针：`web/scripts/build-sites.mjs`、`web/scripts/probe-cloud-agents.mjs`
- 本轮结果目录：`.local/sites/`（四份只读回执）
- 视觉输出：`web/test-results/visual/`、`web/test-results/sites-p0/`；`docs/design/visual-baseline/` 仅为历史基线，本轮未归档
## 17. 发布受阻根因证实与私有部署完成（2026-11-20，第五轮）

- 更正第16节：int32/u64 版本上限假设已被对照实验否定；当时未部署未发布的状态已被本轮改变。
- 对照实验（CLI 1.1.93，回执存 .local/sites/）：会话凭据作用域内 prepare_site 多次返回 sites_invalid_request（exit 2、无字段细节）；未绑定 cwd 直接调用返回 sites_current_session_required；派生 -p 会话间歇 sites_auth_required。改为本地登录+绑定 projectRoot 的直接 CLI 调用后：none 对照草稿被接受（0869bf59，未发布）；read_write+新读 schemaRef 完整草稿也被接受（ab4ae9c6）。包体/路径/项目/函数打包/数据库依赖均合法，拒绝只与会话作用域执行路径绑定。
- bundle 只读定位：prepare 将密封 schemaRef 的 version 经 Number() 注入 requiredSchemaVersion（zod 上限 int32），密封读写按 client scope 隔离；与会话/本地作用域错配致校验失败的现象一致，内部映射未对外暴露，不作过度断言。
- 私有部署完成：verification 01a1f7a0-ed54-790e-955a-a34efdd5ddec 与 publish 01a1f7a2-96de-785d-b786-d5052e3d95e9 均 succeeded；published=true、readiness=publication_completed；hasPublishedContent=true、access_mode=private、functions[app].is_active=true、database_access=read_write。
- 地址 https://campusmate-agent-d6ec0v7a94m.qoder.website（私有，需 Qoder 登录）。未验证：真实浏览器登录与通知到文档黄金流（浏览器 MCP 不可用）；公开访问未开启，需另行确认。
- 恢复规则：Sites 写操作优先用绑定 projectRoot 的直接 CLI 本地登录调用；派生会话路径仅作只读调查。诊断草稿 0869bf59 保持未发布；描述符现指向已发布 ab4ae9c6。
- 证据：.local/sites/block-diagnosis.json、control-none.log、control-rw.log、publish-status-final.json、site-final.json、publish-operation.json。

## 18. 完整应用公开部署与双运行时完成（2026-11-20，第六轮）

### 18.1 交付结果

- 公开地址：https://campusmate-agent-d6ec0v7a94m.qoder.website/（根路径为落地页；应用入口 `/app/`，Qoder 登录入口 `/login/`）。
- 同一部署双态：匿名 = Demo（预置数据，本地渲染）；Qoder 登录后 = 个人空间（同源 cookie + 网关注入身份，`/v1/*` 按 owner 隔离）。
- 最后一版发布：action `0e3e2719-ff89-47b5-aa11-9f431afebfa4`，publish operation `01a1f813-...`，`get_publish_status` = `publication_completed`，`published=true`；访问策略已切 `public`（`confirmPublic=true`）。
- 静态路由回退：平台只对“目录/尾斜杠”回退 `index.html`，`web/scripts/spa-fallbacks.mjs` 在构建后为 12 个已知路由生成 `index.html`；直链请使用 `/app/`、`/app/inbox/` 等带尾斜杠形式，`/app`（无斜杠）会 404。

### 18.2 运行时

- `cloud-agents`：平台托管模型（Qoder Cloud Agents，PAT 由平台注入 `QODER_PAT`），会话懒创建并绑定同一 Agent/Environment；`createProductionSites` 暴露 `resolveBinding()` 供 v1 复用。
- `server-model`：服务端免费模型 `srv-qwen38`（Qwen3.8-27B，low/medium/xhigh，默认 xhigh）、`srv-mimo`（MiMo-V2.6-Flash，low..max，minimal→low）、`srv-moss`（nex-n2.6，minimal..max）；Edge 分步执行器每请求 ≤4 工具轮，checkpoint + lease CAS 续跑，SSE 有界 12 步/50s。
- BYOK：`campusmate_providers` 存元数据，密钥 AES-256-GCM 存 `campusmate_secrets`（`user:<owner>:<providerId>`）；`GET/POST/DELETE /v1/providers`、`POST /v1/providers/:id/default|test`；列表只返回 `hasKey`，任何响应不含密钥；BYOK 调用不发送 `reasoning_effort`。
- Vault：优先 `CAMPUSMATE_VAULT_WRAP_KEY` 包裹 master；平台暂无函数侧 Secret 写入通道，缺省回退为 master 行存原始 key（provider 密钥仍为 AES-GCM）。生产接入 Sites Secrets 后应删除该回退。

### 18.3 数据

- 迁移 v1（11 表）、v2（secrets + tasks 列）、v3（campusmate_providers）均已 applied；目录共 15 张表。
- `web/scripts/bootstrap-server-keys.mjs --apply` 按真实 `insert_database_rows` 契约（siteId/tableName/requestId/schemaRef/rows[{cells}]、`--input-file`）写入 `__master__`、`radeon`、`moss` 三行；requestId 持久化在 `.local/sites/bootstrap-request.json`，重试复用；`query_database_rows` 已核对三行存在且未输出任何密文。

### 18.4 验收证据（本轮）

- `web` 全量单测：65 文件 / 483 项全部通过（含新增 sites-v1/exec/repository/auth-cloud；修复 config 部分 mock 导致的既有失败）。
- 视觉基线：`node node_modules/playwright/cli.js test e2e/visual-system.spec.ts` 7/7 通过。
- 匿名冒烟（curl）：`/` 200、`/app/` 200、`/login/` 200、`/__qoder_auth/start?return_path=%2Flogin%2F` 302、`/functions/v1/app/v1/capabilities` 401 `login_required`。
- 浏览器匿名验收（Browser 子代理）：落地页、Today、对话、Inbox、日程、机会雷达、可信核验、成长、设置均渲染；已修复“课表读取失败”误报（云端匿名不再请求需登录的 `/v1/terms`）与匿名 `/v1/providers` 401。

### 18.5 仍待人工完成

- Qoder 登录后的个人空间黄金流（登录 → 新建对话 → 选择服务端模型 → 工具写入 → 产物预览/下载）需要真实浏览器登录，本轮未替代用户输入凭据；入口已就绪：https://campusmate-agent-d6ec0v7a94m.qoder.website/login/
- 登录回跳路径已规范化为带尾斜杠（`/login/`），并在回跳后自动进入 `/app`。

### 18.6 复现

```powershell
cd C:\Users\Asus\CodeBuddy\campusmate-builds\agent-local-workspaces\web
$env:VITE_RUNTIME = "cloud"
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node scripts/build.mjs
node scripts/build-sites.mjs
# prepare/publish 使用 .local/sites/in-prepare-full.json（actionId 每轮新生成）
```
## 19. 流式、思考摘要、并行工具与索引（2026-11-20，第七轮）

- 服务端模型改为上游 SSE 流式：`llm.delta` 每 250ms 或 480 字符批量落库；`/v1/tasks/:id/stream` 在 advance 进行期间每 280ms 拉取新事件推送，首字体感接近流式；上游拒绝 stream（400/404/405/415/422）时自动退回一次性请求。
- 同一轮多个工具调用改为并行执行；`tool.called`/`tool.result` 各用一次 seq CAS 批量写入，事件新增 `callInstanceId`、`argsSummary`（最多 4 个键、200 字符）、`durationMs`。
- L2 思考摘要：服务端解析 `reasoning_content`/`reasoning`，每轮只写一条 `thinking.summary`（excerpt ≤240 字符、chars、durationMs），不落原始思考；Cloud Agents 的 thinking 有 content 时同样只落有界摘要；工作台「思考摘要」默认折叠并标注“自动截取，非完整推理”。
- `llm.response` 增加 `durationMs`、`reasoningChars`；`llm.request` 标记 `stream: true`。
- DB：迁移 v4 增加 7 个热路径索引（events owner+task+seq、messages owner+session+ord、tasks owner+session/status、approvals/artifacts owner+task、conversations owner+updated_at），migration `01a1f851-08b6-718d-b270-2c5ca863723d` applied。
- 测试：全量 `487` 项通过；新增流式增量、思考摘要边界、并行工具、stream 回退、Cloud thinking 映射用例；视觉基线 7/7。
- 发布：action `0be591ee-9d6c-4da9-9bb3-1454a8acdeef`，`publication_completed`；线上资源 `index-5fjHUySH.js`。
## 20. 聊天内实时进度与长任务自动续跑（2026-11-20，第八轮）

- 聊天框内新增「正在执行 · 实时进度」块：运行中直接显示工作步骤、每步参数/耗时、思考摘要和流式草稿；完成后仍由 assistant 消息内的工作步骤回看，避免只依赖右侧执行面板。
- 流式窗口结束但任务仍在 running 时，客户端不再当作结束：`close` 事件读取状态，非终态则继续轮询并自动重连 SSE，不需要用户再输入“继续”。
- 思考 token 计入 `max_tokens`：阶段预算上调（simple 4096 / write 8192 / plan 6144 / verify 3072 / summary 1536 / extract 1536）。
- 截断或空正文不再伪装成“已完成本轮处理”：保存 checkpoint、追加“继续输出”提示并返回 running 自动续跑；两次仍为空则如实标记 `server_model_empty_response` 失败。
- 上游实测（只记录字段与耗时，不记录内容/密钥）：Qwen3.8-27B 首个 reasoning 约 4.1s；MiMo-V2.6-Flash 约 17.9s；nex-n2.6 约 1.7s；三者 SSE 均返回 `reasoning_content`。
- 测试：`489` 项通过（新增截断续跑、SSE 时间窗自动重连）；视觉基线 7/7。
- 发布：action `ab1d70a1-8fc7-4d78-affc-78ff730e4e21`，`publication_completed`；线上资源 `index-CpTkqZoL.js`。
## 21. 权威时间注入与日期幻觉修复（2026-11-20，第九轮）

- 根因：服务端模型与 Cloud Agents 的系统提示没有当前时间，模型用训练记忆猜日期（实测思考链出现“2026年6月19日”）。
- 新增 `web/functions/current-time.ts`：统一输出北京时间的日期、时分秒、星期与反幻觉规则。
- 服务端模型：每轮 `requestMessages()` 动态注入权威时间（跨午夜续跑也正确）；`llm.request` 事件记录 `serverNow` 便于审计；系统提示新增【时间】规则，时效信息必须检索核验。
- Cloud Agents：每条用户消息（含“继续”）前置权威时间与【用户消息】分隔；P0 `/runs` 通知原文同样前置；`sites-config` 的 Agent system 增加时间规则（新 Agent 生效）。
- 本地浏览器对话原本已注入北京时间；本机 Node 后端也在 taskContext 注入北京时间，无需改动。
- 测试：`490` 项通过（新增 system 时间注入、Cloud 消息前缀、P0 通知前缀断言）；视觉基线 7/7。
- 发布：action `7d922b46-52f7-4561-bad1-93171b6c30de`，`publication_completed`。
## 22. 聊天布局、上下文上限编辑与截断修复（2026-11-20，第十轮）

- 输入区压缩：Textarea 高度 2 行→1 行（min-h-9、max-h-32），输入区 padding 3→2；对话区自动获得更大可视高度。
- 移除「保留的草稿版本」整块 UI；草稿状态行只在保存时出现，不再常驻。
- 修复对话与输入框之间的截断：消息滚动区增加 scroll-pb-6，内容底部 pb-8，避免最后一条消息被输入区边缘裁切。
- 上下文指示器：优先用最近一次 `llm.response.usage.input` 计算占用百分比；上限按 Provider 元数据（Qwen3.8-27B 262,144 / MiMo-V2.6-Flash 1,048,576 / nex-n2.6 未公开按 256K 保守值）显示，未知时仍显示“窗口未知”。
- 支持在原地点铅笔修改本会话上下文上限（8K–2M），可一键恢复模型默认；修改对后续任务生效，并写入 server-model checkpoint，Edge 执行器按该上限裁剪历史（保留首条任务与最近消息）。
- 后端 `/v1/providers` 暴露 `contextLimit`；`publicProvider` 透传；前端 `TaskInput.contextLimit` 随任务提交。
- 测试：`492` 项通过（新增 ContextUsage 编辑用例）；视觉基线 7/7；截图确认输入区单行、无草稿版本块。
- 发布：action `c73c65c7-6b6d-4420-acf5-4dca3cc68653`，`publication_completed`。
## 23. 思考实时流与 Cloud Agents 诊断（2026-11-20，第十一轮）

- 服务端模型：reasoning 增量每 300ms/240 字符写 `thinking.delta`（每轮上限 6000 字符），聊天内「思考中（实时）」边思考边显示；轮末仍保留 `thinking.summary` 供回看。
- Cloud Agents thinking 事件同时映射 `thinking.delta` 与 `thinking.summary`。
- Cloud Agents 失败定位：历史任务错误为 `sites_dependency_unavailable`（通用 503）。`resolveBinding` 现在解析 initialize 返回的安全错误码并抛出 `CloudAgentError`，`/v1` 保留 `ai_*` 错误码；新增登录态诊断端点 `GET /functions/v1/app/v1/cloud-status`，返回 `tokenPresent`、初始化错误码与平台启用模型列表（不含密钥）。
- 测试：`492` 项通过；视觉 7/7；发布 action `21c410f3-0d42-4698-9880-26891b862f9a`。
## 24. 会话上下文连续性与 Cloud 模型诊断（2026-11-20，第十二轮）

- 根因：server-model 每个任务的 checkpoint 只含当前输入，未读取同一会话的历史消息，导致同会话多轮像“四个新会话”。
- 修复：创建 server-model 任务时读取 `campusmate_messages` 最近 20 条 user/assistant 消息（按 ord 排序），与当前输入一起写入 checkpoint；图片改挂到最近一条 user 消息；contextLimit 裁剪仍保留首条与最近消息。Cloud Agents 继续复用平台 Session，本身保留上下文。
- Cloud Agents：`/v1/cloud-status` 返回 `ai_model_not_enabled`、`tokenPresent=true`、`models=[]`。已将模型校验改为“仅显式 is_enabled=false 才拒绝”，并让诊断端点返回 `modelsRaw` 与 `modelsError`，便于确认平台模型列表响应结构/权限。
- 测试：`493` 项通过（新增同会话历史注入用例）。
- 发布：action `361de372-b629-46bf-aded-80a5f23a5340`，`publication_completed`。