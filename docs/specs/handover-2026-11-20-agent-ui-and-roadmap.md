# Handover · 2026-11-20 · CampusMate Agent UI + 路线图

> 给接手的 Agent：先读本文件，再按「启动提示词」执行。仓库：`C:\Users\Asus\CodeBuddy\campusmate-builds\agent-local-workspaces`
> 分支：`feature/agent-local-workspaces`（已推送 origin）。远端：https://github.com/WorldExcuteMe/CampusMate/tree/feature/agent-local-workspaces
> 本文件所在提交之后，分支即可继续开发；**不要重写历史、不要 force push 到 main**。

## 1. 项目定位（不要偏离）

- CampusMate 是**本地优先的 Web Agent**（类似 DeepSeek Harness / Hermes 的开源形态）：用户在自己机器上启动进程，
  浏览器打开 `127.0.0.1`，账号/会话/工作区/文档/密钥留在本机。
- 比赛交付形态：**本地完整版为主** + **Qoder Sites 公开演示版为辅**（内置 Qoder 登录 + Deno Edge Function + Sites DB/对象存储 +
  Qoder Cloud Agents，只跑云端受限工具）。云页面不能让评委远程操作本机文件/终端，作品帖要写清边界。
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

### P2 · Qoder Sites 云端演示（比赛公开链接）
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
