# CampusMate 本地工作区与 Agent 能力特化

日期 2026-11-18。基线为远端 `develop` 的 `c506d0f0265e0b5c0425e67af15e3a99b6efc38e`。功能分支 `feature/agent-local-workspaces` 使用独立 worktree。仓库及适用祖先未找到 `agent.md` 或 `AGENTS.md`，遵守用户提供的全局契约和仓库 `.github/CONTRIBUTING.md`。按用户要求单代理推进。实施阶段等待用户依全局契约明确授权。

## 目标与执行设计

1. **W1 本地工作区与权限**。聊天提交时选择云端或本地根目录及权限，任务建立后固定其工作区标识，审批、恢复和工具执行解析同一工作区。单进程本地入口装配现有 API、Worker、审批、存储与用户界面。绑定回环地址，使用本地会话授权，按工作区隔离任务、产物、浏览器资料目录和本地持久存储。优先验证现有 PGlite 适配器可否复用原迁移及持久存储。云端任务继续走原路径。
2. **W2 编程与长任务**。通过本地工具插件提供有限结果的文件列表、内容搜索、分页读写、结构化命令执行和已登录网页的目标页读取。文件工具规范化实际路径，验证符号链接和 Windows junction，执行器固定工作目录，限制超时和输出。请求批准模式对写文件、运行命令和读取已登录私有来源展示确切操作及目标，绑定本任务与工具参数，由服务端检查后执行。完全访问为用户在本机显式选择的免逐次批准模式，按当前本机账户权限执行。任意进程的工作目录只用于任务组织，文件 API 的路径检查不构成进程级沙箱。两种模式均校验设备、工作区、私有目标及已选账号权限。用现有计划、预算、checkpoint 和租约保护实现规划、执行、验证与恢复，给未确认副作用保留人工复核入口。
3. **W3 QQ 与微信群**。优先适配已登录客户端的可访问界面或用户授权导出。复用仓库的群消息结构、通知筛选、去重和入库逻辑。从指定群读取有来源、有限范围的消息，返回读取范围、条数及信息摘要。现存旧 CLI 涉及从客户端进程读取密钥和离线解密，新的产品插件使用客户端界面或授权导出作为数据入口。以群号 `881289395` 验证群身份。群名称相同或只能看到部分记录时向结果暴露限制。
4. **W4 学校与小程序课表**。高校网页登录由用户完成，Agent 使用该工作区的浏览器会话读取授权页面和导出文件。真机 QQ 和微信使用匹配窗口和用户可见界面。微信小程序选择「太理助手Pro → 我的课表」，优先读取界面文本和逐条详情，必要时使用受限 OCR。用户提供的截图只作定位第 11 周界面和理解样式的依据，灰色「非本周」与截断文字需从真实页面和课程详情核验。遍历学期可访问周次，校验课程名、上课日期或周次、节次或起止时间和地点。输出与当前导入器兼容的 JSON/CSV，并在本地预览、去重、查冲突，确认后在 CampusMate 课表页读取回验。遇到不可读字段保留来源和缺口。
5. **W5 工具、技能与用量**。构建静态内置插件目录，按任务能力可见，使用精简目录和按需加载技能正文。覆盖公开网页与 GitHub 只读检索、本地编程、群消息、课表和文档写作/导出。工具注册仍受 Manifest、参数校验和审批约束。将长结果以任务产物保存，模型默认只见必要摘要和可翻查引用。复用现有 DOCX/PDF 生成链。固定工具顺序和稳定系统前缀，计划进度等动态数据放在后层。以可重复评测记录请求体估算 token、提供商实际输入/缓存读取 token、工具观测大小和任务成功率。缓存字段缺失记录为未知。
6. **数据流与回退**。真实群消息、课表原文和截图先留本地。如任务选择远程模型，需要确认拟传数据和目的地，或改用本地处理。QQ 与微信验收使用各自的新工作区。启动配置选择云端或本地，旧云端数据和任务继续使用当前契约。功能分支可独立撤销；本地测试数据目录由用户选择是否保留。

## 影响面

均以 `c506d0f` 为定位基准。新增文件在实现后补位置。

| ID | 当前入口 | 改动或调用面 |
| --- | --- | --- |
| W1 | `web/src/features/agent/AgentChatPage.tsx:77,173,223,389`，`web/src/lib/agent/api-client.ts:49`，`backend/src/main.ts:15–25`，`backend/src/app-context.ts:56–91` | 目录目前只保存在浏览器。本地入口和任务提交需要绑定实际执行与存储，旧任务缺少字段时沿用云端路径。 |
| W1–W3 | `backend/src/core/companion.ts:5–63`，`backend/src/core/manifest.ts:28–51`，`backend/src/runtime/worker.ts:272–328,522–536`，`backend/src/runtime/approval.ts:57`，`web/src/features/agent/TaskWorkspace.tsx:49,79` | 接入本地工具、限制能力、按请求审批并由任务重试与租约接续。新增本地执行适配器。 |
| W2/W5 | `backend/src/core/planner.ts:31–95`，`backend/src/core/context.ts:116–164`，`backend/src/core/llm.ts:78–102,148–159`，`backend/src/core/cloud-tools.ts:17–91` | 复用规划与工具注册。加入按需技能、检索与缓存观测对照。 |
| W3 | `skills/qq-wechat-ingest/SKILL.md`，`web/src/lib/ingest/qq.ts:8–29,78–89`，`web/dev/llm-proxy.mjs:156–230` | 复用规范化消息与同步业务。从可见界面或授权导出接入新适配器。 |
| W4 | `backend/src/core/schedule-import.ts:29–40,103–158`，`backend/src/api/server.ts:301–322`，`web/src/features/calendar/ScheduleImport.tsx:32` | 复用导入校验、预览、确认和课表反查。新增源适配器和导出。 |

## Given / When / Then 与验证

| ID | Given | When | Then | 验证 |
| --- | --- | --- | --- | --- |
| W1 | 云端旧会话、本地 A/B 两个工作区 | 本地 A 发任务后切 B 或重启本地服务 | A 的任务、文件、审批与历史归属固定，云端原任务仍可用 | API + Worker + UI 测试 |
| W2 | 请求批准或完全访问，任务要求生成脚本并执行验证 | 批准、拒绝、授权过期或显式用完全访问 | 审批前无副作用；拒绝、错任务及过期均无执行；允许的运行返回退出码、输出与真实产物；中断重试不重复未知写入 | 本地权限、文件边界与进程测试；真实脚本任务 |
| W3 | 已登录 QQ/微信或有用户授权的导出 | 在独立工作区查目标群 | 证据能回指目标群和时间；消息去重且没有其他群数据；不可达时明确状态 | 适配器回归；QQ `881289395` 真机产品流程 |
| W4 | 微信已登录，目标小程序提供本学期多周课表 | 读取、生成导入文件、预览与确认 | 周次和课程数量可核对；重复导入不会重复课程；课表页面可见实际写入的课程 | 校验样例；「太理助手Pro」真机产品流程 |
| W5 | 同一模型重复相同前缀，混合简单与长任务 | 比较基线和候选分支 | 未激活技能内容不注入；工具和固定前缀顺序可复现；报告提供商实际值及成功率 | 请求快照、真实模型用量对照、文档交付回归 |

串行验证。先补能区分现有与新行为的断言，以真实行为缺口点亮 RED，再完成实现并复跑。之后运行后端类型检查和测试，前端构建、单测和 E2E，确定性评测及两条独立工作区真机验收。已有基线 `node --test --test-concurrency=1 src/core/capability.test.ts src/core/companion-wss.test.ts src/core/planner.test.ts src/core/llm-policy.test.ts src/runtime/worker-approval.test.ts src/runtime/worker-companion.test.ts src/api/calendar-api.test.ts` 退出码 0，`tests 32`、`pass 32`、`fail 0`。Windows PowerShell 实测 7.6.9，Node v24.21.0。真机预检发现 QQ、微信窗口，未发现标题为「太理助手Pro」的独立窗口。当前主窗文本树未暴露搜索/小程序入口，后续需用可见界面核对。

## GitHub 调研与取舍（2026-11-18）

来源版本为当日页面。实际依赖与固定版本在实现记录中按锁文件核验。

| 能力 | 候选 | 采用方式 |
| --- | --- | --- |
| 技能、工具检索 | [Agent Skills](https://github.com/agentskills/agentskills/blob/main/docs/client-implementation/adding-skills-support.mdx)、[Anthropic 示例](https://github.com/anthropics/skills)、[Vercel AI SDK 工具调用](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx) | 采用短目录、按需正文、带参数验证的工具调用。沿用 Agent Loop 的 checkpoint 和现有原生/JSON 工具协议。 |
| 本地编程 | [OpenAI Codex 配置](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)、[ripgrep](https://github.com/BurntSushi/ripgrep) | 借鉴工作目录和审批分层。有 rg 时复用其过滤和搜索能力，提供有界回退。 |
| 搜索与浏览器 | [GitHub MCP](https://github.com/github/github-mcp-server)、[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | 内置 GitHub 只读入口和基于已锁定 Playwright 的会话适配。可执行外部插件需逐个审定身份及能力，按首批验收需要再决定是否接入 MCP 传输。 |
| 文档 | [MarkItDown](https://github.com/microsoft/markitdown)、[Anthropic Skills](https://github.com/anthropics/skills) | 参考面向模型的结构化输入和文档检查思路。优先复用已测试的 CampusMate 文档解析与导出，避免重复安装同用途依赖。 |
| 用量与缓存 | [Context Mode](https://github.com/mksglu/context-mode)、[ccusage](https://github.com/ccusage/ccusage)、[Qwen Code 稳定工具排序](https://github.com/QwenLM/qwen-code/blob/main/docs/design/prompt-cache/global-tool-schema-stable-sort.md)、[OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) | 采用有界结果、按需读取和稳定前缀。现有适配器已经排序并归一化两类缓存字段，需 A/B 证明实际收益。Codex TokenEconomizer 的度量只适用于开发会话，产品用量由产品评测验证。 |

两项关键假设可用集成测试推翻。第一，本地组合运行可以沿用现有持久存储接口；若 PGlite 无法兼容必要行为，改为仓库已支持的专用本地 Postgres。第二，真实小程序可以通过可见界面或导出取得完整学期；若缺少周次或详情，记录实际可达范围和复现条件，不能以截图推断学期。比较了云端控制本机 Companion 与本地组合运行，前者适用于已有 WSS 团队部署，后者便于工作区绑定及个人资料留在本机。

## 候选分支验证

- 本地运行从已存在目录启动，前端在该进程提供的回环地址显示目录名和权限。需要先按仓库流程构建 `web/dist`，再运行 `npm --prefix backend run local -- --workspace <目录> --port 8790`。另一个目录使用另一个本地实例和端口。可重复指定 `--campus-origin`、`--qq-group`、`--wechat-group`。本机模型使用回环地址。允许远程模型使用工作区资料需要显式启动参数。
- 本地执行集成测试实际启动 PGlite 和 Worker。审批了两次具体操作，真实脚本输出 `workspace-script-ok`，并验证另一目录无法读取任务、重启后原任务及权限仍可读。课程导出测试包含真实作息、单双周、冲突保留和缺少时间拒绝。
- 真机 QQ 群资料显示目标号码。可见消息导出保存在独立本地工作区，使用确定性测试模型走真实本地 Agent API、审批和文件读取，任务状态为 `succeeded`，读取 4 条匹配通知。已登录客户端的直接采集仍需产品级适配。
- 真机太理助手Pro 显示 24 个周次选项。已读取 4 条含周次、星期、节次、实际时间和教室的课程规则，并在独立本地工作区生成 CSV。复读有效 4 条，错误 0。学期覆盖仍不完整，课表页面尚未写入真实数据。
- 目标验证 `node --test --test-concurrency=1 backend/src/runtime/local-workspace.test.ts backend/src/core/llm-policy.test.ts backend/src/api/calendar-api.test.ts` 退出码 0，11 项通过。后端类型检查、前端类型检查及生产构建通过。JSON 工具协议固定前缀已用请求测试验证，实际提供商缓存命中率待测。

