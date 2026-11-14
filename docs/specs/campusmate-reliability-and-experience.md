# CampusMate：个人上下文、可见执行与竞赛策划书交付

## Status

Phase 4 — in progress. 用户已批准 Spec v2、实施计划及范围内子任务阶段委托。

执行方式更新：用户随后明确“将子智能体召回，你来进行全权任务吧”。所有运行子代理已中断，后续由主代理单独实施、测试、自检与提交，采用 spec-tdd-workflow；下文历史的子代理分工不再作为调度指令。

- 版本：v2，纳入用户新增的调用调优、time table、思考策略及 Word/PDF/通用工具评估。
- 档位：Standard。涉及跨模块行为、用户数据、任务契约、模型配置及视觉交互。
- 日期：2026-11-14；项目工作区：`C:\Users\Asus\CodeBuddy\qoder比赛`。
- Git 恢复基线：`main`，HEAD `060c09b028ed0750269a8e2e9905d35663346b05`，开始时工作树干净。
- 补充备份：`.agent_versions/v1_CAMPUSMATE_PLAN_20261114-131859/`；仅本地恢复记录，不纳入提交或上传。
- v2 修改前/后备份：`.agent_versions/v2_CAMPUSMATE_PLAN_20261114-132925/`，保留 v1 文档原件。
- 用户在总审批问题后回复“确认”；本文件 v2 的契约、实施范围和技术方案获准实施，新增范围/不可逆动作仍单独确认。
- 实施分支：`codex/campusmate-reliability-experience`；实施补充备份：`.agent_versions/v3_CAMPUSMATE_IMPLEMENT_20261114-135858/`。
- T1 已提交并本地验收（e9d83d4）；T2 会话/画像/原子轮次/恢复/UUID映射已完成本地验证，后端218项与前端104项通过，详见子规格。后续继续T3/T4/T5/T9及文档闭环；尚未声称整体交付。

## Problem and goal

用户要求接手已有 CampusMate，检查既有阶段成果，改善 UI、执行过程反馈、记忆与上下文、自定义模型，以及复杂任务产出。保留有效 Agent 框架，将这些能力接成真实用户可使用的闭环。

本轮目标：用户说明身份后可以连续提问，知道 Agent 正在做什么，实际使用所选模型，看到准确校园安排，并收到有来源、可预览下载且经过完整性检查的竞赛项目策划书。

## Scope

- R1：接通用户级会话历史、既有个人画像和任务上下文，纠正窗口占用展示。
- R2：统一实际模型信息，补齐认证后端的用户级 OpenAI-compatible 自定义接入。
- R3：展示真实 Task/Step/Tool/Event、审批或补充信息原因，支持刷新后继续查看。
- R4：修复日历日期/调课/未知数据问题，接通标准课表导入预览与确认。
- R5：实现竞赛策划书的资料→提纲→分章节正文→检查→有限修订→文件交付。
- R6：以明亮学院风完成 Inbox 和 Calendar 样板，协调工作台/模型设置及 Today 的必要接线。
- R7：补齐以上场景必需的共享持久化、集成测试和证据，区分本地测试与真实环境验收。
- R8：建立跨供应商调用策略与观测，改善稳定前缀、上下文、缓存、输出预算、重试、超时、流式反馈及用量解释。
- R9：支持 auto/low/medium/high 思考偏好，依据任务阶段、端点能力和预算决定实际参数。
- R10：通用结构化文档生成、DOCX/PDF 导出与内容/渲染检查；评估隔离计算工具与本地 Companion 的能力边界。

## Non-goals

- 不重写现有 Agent Core/Task Runtime，不增加多 Agent 产品框架、微服务或第二套业务数据库。
- 本轮不承诺原生 Anthropic 等未实现协议；首批准确支持 OpenAI-compatible，其他协议入口明确不可用。
- 文档交付扩展为 Markdown/DOCX/PDF；任意已有 Office 文档无损编辑、任意网页适配和全网采集不纳入本次完成条件。
- 通用代码沙箱本轮完成接口、部署条件及验收方案评估，不将未经隔离的宿主 exec 开放为云端 compute；实际沙箱部署与收费服务选择另行确认。
- 不为 KV 命中率单项数字承诺固定阈值，不向未知端点强塞某厂商的 cache/thinking 参数，不把所有“API Key”视作同一协议。
- 不自动导入或上传旧浏览器聊天历史，不改变现有外部副作用审批边界。
- 不部署、不发布、不 push、不运行远程数据库写入/迁移，不替用户报名、发送信息或提交申请。
- 不将脚本模型基准、本地 PGlite 或假上游测试表述为真实模型质量、真实 Supabase RLS、分布式并发或高校泛化验收。
- Companion 跨进程 RPC/NAT、完整监控告警、全类型长期记忆及全站逐页重做另列后续任务。

## Confirmed decisions

1. 用户：明亮学院风——暖白底、紫蓝主色、青绿与珊瑚点色。
2. 用户：首个复杂任务为竞赛项目策划书，包含资料、提纲、正文、引用及下载。
3. 原请求：检查和补齐既有成果，不从头构建已完成模块。
4. 全局 AGENTS：指定真实 PowerShell 路径；闸门/构建不得并行；初始需求和沉默不构成 Phase 4 授权。
5. 用户级全局 AGENTS 允许子代理探索；本次“确认”同时批准 v2 总计划及主代理在其范围内审核、推进子任务阶段。
6. 本机 PowerShell `C:\Users\Asus\AppData\Local\Programs\PowerShell\7\pwsh.exe` 实测 7.6.9；技能旧 `Program Files` 路径冲突，以用户指令为准。
7. 用户补充：除了 KV Cache，还要从多方面调优 LLM 调用，提升多数自定义模型接入的适应性。
8. 用户提供高校 time table 参考并要求评估；采用程度及下述具体交互属于待批准方案，不能将参考图的全部细节当作必须照搬。
9. 用户补充：复杂任务可以适当放开思考强度；要求评估 Word/PDF 与编程工具，目标为尽可能提高通用 Agent 能力。

## Functional requirements

### R1 会话、画像和上下文

- 以认证用户和 UUID sessionId 定位后端会话；读取同会话已提交消息和既有 profile，组装后再调用模型。
- 会话消息与本任务 checkpoint 分开保存；按 taskId/turnId 幂等写入，任务重认领不重复追加消息。
- 同会话运行中的提交保持顺序；界面不得让后一任务在前一轮尚未写回时静默读取旧上下文。
- 近期历史、历史摘要、结构化画像、当前任务状态分层；压缩保留工具调用配对、用户身份和最新纠正。
- 本轮用户明确纠正优先于旧摘要；不自动将临时聊天推断覆盖 profiles。长期画像修改经既有编辑/确认入口。
- 新后端会话使用 UUID。旧 localStorage 非 UUID 会话保留可读，另建映射；历史内容上传必须由用户选择，默认仅同步新提交。
- 浏览器 Demo 的旧全局记忆不跨登录用户复用；真实用户隔离键包含 userId，切换账号清理当前内存订阅。
- 当前请求的 prompt tokens/上限/输出预留与累计消耗分开返回；没有真实统计时显示估算或未知，不伪装精确占用。

### R2 模型供应和用户密钥

- 后端提供默认供应商及用户自定义供应商的统一公开 DTO：id、displayName、protocol、modelId、hasKey、capabilities、contextLimit、metadataSource。
- 任务创建记录用户选择的 providerId/modelId 配置快照；Worker 依据任务 owner 解析凭证，不能忽略前端选择。
- 运行记录区分配置模型和上游实际返回模型；UI 名称、能力和上下文分母消费同一份有效配置。
- 供应商缺失、凭证无效、上游协议错误、能力不足分别给可读错误；不得静默换模型或转成成功的 Mock 结果。
- 新增/编辑/测试连接/设为默认/删除均经认证 API；不提交新密钥表示保留原密钥，明确移除凭证是单独动作。
- 提议凭证实现：Node 内置加密封装 AES-256-GCM 密文，包含 keyVersion/nonce/tag；主密钥仅服务端环境持有。未配置主密钥时拒绝持久化密钥，不以明文回退。
- 公有配置、task/event/checkpoint、日志和前端存储不包含 API Key；用户列表仅返回 hasKey。服务端每次读取与修改都校验 owner。
- 能力元数据标注来自配置或探测；未知模型不能仅凭名称声称工具/图片能力或窗口大小。连接测试由用户主动触发；自动测试只用本地假上游。

### R3 可见执行与恢复

- 接通已有 SSE 的 onEvent，显示排队、模型请求、工具执行、来源核验、产物生成和验收的真实状态与耗时。
- 工具事件带 stepId/toolCallId/invocationId，使用 seq 去重和补拉；同名多次调用可区分。
- SSE 断开后轮询同时补任务状态及 afterSeq 事件，恢复 SSE 后不重复、不错序。
- 持久化 session↔task 关联；刷新/重登后加载任务并继续订阅。组件卸载清理订阅与计时器。
- paused/needs_input 显示结构化原因：审批、缺少信息或预算；不能全部解释为高危操作审批。
- 复用真实取消/恢复能力；本次不添加无后端行为的“暂停”按钮。预算或验收未完成时保留草稿，明确显示未完成原因。
- 默认展示短执行说明、工具名、来源和结果摘要；参数及结果先脱敏，不展示私密思维链或虚构进度。

### R4 校园安排正确性与导入

- 日历按所选具体日期范围和学期时区展示；任务/机会截止不能因星期相同在其他周重复出现。
- 课程规则叠加停课、补课、调课、教室变化及节假日例外；一次性截止与实际占用时段分开。
- 完成/取消任务和归档机会不作为未来待处理安排；逾期项目单列，不能计入“未来七天”。
- 区分 loading/error/empty/partial-data；课表未知或失败不能导出“全天可用”。空闲建议扣除已有定时安排，并说明数据完整程度。
- Calendar 提供 ICS/CSV/XLSX 导入入口，复用后端解析。上传→预览错误/重复→明确确认→保存→刷新，不能直接覆盖已有课表。
- Today 复用已有 selector，展示真实今日课程、下一项安排、待办和临近截止；不只改导航名称。
- time table 采用左侧节次+真实时间、顶部日期/教学周/今天、跨节课程块及回本周；课程颜色稳定分配，不照搬参考图的高饱和彩虹和窄列竖排。
- 提议新增学校/校区/学期生效的作息模板（period index/start/end、effectiveFrom/To）；支持午休、晚课、不同课长和夏冬作息。以真实时间存储安排，节次是输入/显示辅助。
- 原课 reschedule 的源日期/目标日期语义必须明确并兼容旧记录，避免仅新增目标课却未取消源课；选定学期及第一教学周锚点可校正。
- 非本周课程默认不进入有效安排；可选灰色虚线参考层，不计冲突/空闲。重叠安排并列并标冲突，当前时间线只显示于学校时区的今天。

### R5 竞赛项目策划书

- 明确任务类型 proposal；从用户目标和已知背景构建提纲及冻结的非空验收条件。
- 复用 Planner/Step/Checkpoint，按资料、提纲、分章节草稿、检查、交付执行；已完成章节可恢复，不重做全部步骤。
- 缺少学校/项目方向等确实影响产出的材料时列出缺口；对话里已知的信息不重复索要。
- 至少覆盖背景与问题、目标、方案与步骤、分工与进度、资源/预算、风险、参考来源；用户自定章节和字数要求优先。
- 事实性外部主张关联已取得的 source/evidence；提案、估算和待核实信息明确标识，不伪造官方来源或 VERIFIED。
- 检查必需章节、用户明确的长度要求、引用关联、产物存在和可读性；字数不能单独判定质量。测试采用合成约束，不把三千字设为所有用户的固定要求。
- 提议最多一次有针对性的自动修订，仍不满足则返回具体差距和未完成草稿；所有步骤受现有预算约束，不进行无限重规划。
- 普通闲聊可以正常完成；proposal/调研等业务任务不能因模型可达就成功。工具执行失败、检查不通过、预算耗尽不能冒充完整交付。
- 提议沿用既有任务 status，增加 completion.state=complete/partial、reason 和 checks；预算耗尽使用 paused+budget_exceeded，需用户明确调整后恢复。
- 产物保存任务 owner、版本、内容、引用和哈希，回填 artifactIds；支持授权读取、结构化章节预览及 Markdown/DOCX/PDF 下载。预览不用执行任意模型生成 HTML/脚本。
- 竞赛策划书是首个纵向验收场景，文档引擎接受通用 heading/paragraph/list/table/image/chart/reference blocks，不绑定单一策划书模板。

### R6 视觉和交互

- 基于现有 theme tokens 实现明亮学院风；保留暗色选择和用户已保存的主题偏好，首次无偏好使用明亮方案。
- Inbox 桌面采用紧凑列表与详情预览，窄屏采用单列表；突出标题、下一步行动、截止和来源，提供待处理/临近截止/归档与搜索。
- 状态文案中文化，标签/边框/阴影降低重复权重；来源链接可查。Mock 标识由真实 provenance 决定，不能无条件贴在真实记录上。
- Calendar 桌面周时间轴与全天截止条，窄屏默认单日议程并可切周；显示实际日期，长标题可查看详情。
- Workspace 统一聊天、执行时间线、审批/补充信息和产物区域；模型设置卡片说明默认模型和自定义接入状态。
- 覆盖 390/768/1440px、亮暗主题、长标题、键盘焦点、加载/失败/空/部分数据；颜色不能作为状态的唯一识别方式。

### R8 跨模型调用与缓存调优

- 缓存截图仅作用户观测样本：Gemma-4-31B-IT，68 requests，Prefill 91184，KV Hit 41151/45.13%，Cache Write 0，Decoding 7830，Reasoning 0。未知供应商统计口径；不能据此认定 68 个用户任务、关闭推理、没有缓存写入或提示词就是低命中根因。
- 修复动态内容过早打断稳定前缀：固定规则、工具 schema/版本和较稳定画像快照在前，时间、task/step 状态、相关材料及当前输入后置；不要为了命中率延长无用提示词。
- 工具集合仍按授权/任务范围过滤，确定性排序并记录集合版本/指纹；不能为了固定前缀给模型越权工具。
- 工具长输出首次进入模型前生成稳定摘要+artifact 引用，后续按需分页读取；同任务尽量追加消息。压缩可重建缓存，但必须优先保住事实、约束与工具配对，不为缓存保留垃圾历史。
- ProviderCapabilities 增 protocol/API variant、tools/JSON/vision/streaming、输入/输出上限、reasoning 参数族、缓存控制及 usage 口径；每项支持 unknown，标注来源，不能只按模型名正则猜测。
- 第一认证范围仍是 OpenAI-compatible；原生 Messages/Gemini 等通过独立 adapter 扩展。原生协议在字段映射、工具回传、usage、错误及思考签名/续传等 fixture 验证完整前不开放产品选项。
- 输出/思考预算与任务剩余 deadline 统一下发；只发送端点支持的 temperature、输出上限、工具与结构化输出参数。
- 不支持 native tools 的端点可选择受限 JSON 工具协议：严格 schema、工具 allowlist、参数验证、有限修复；不能将普通文字当任意命令执行。无法可靠调用工具时明确显示能力受限。
- 统一重试负责人和总 attempt 上限，取消代理/浏览器多层乘法重试；区分 400/401/额度/429/5xx/超窗/截断，消费 Retry-After，所有退避和响应体读取受同一 deadline 约束。
- 先保留并接通真实 Task/Tool 事件，再为支持端点增加正文 streaming；收到响应头不代表完整响应成功，断流/finish_reason=length 不可标为完整成功。
- 统一观测 requestId/attempt、稳定前缀指纹、模型、TTFT/总耗时、stop reason、原始及归一化 usage。inputTotal/cacheRead/cacheWrite/output/reasoning 允许 null；缺失不填 0，reasoning 已包含在 output 时不能重复相加计费。
- 缓存参数/TTL/断点按供应商和模型/API 版本适配；不认识的参数不发送。自有检索/解析结果缓存按 user/来源/版本和时效失效，不把过期校园通知反复当新数据。
- 费用以端点价格配置和实际 usage 为依据；截图 pts 不能直接换成 USD。价格未知显示未知/明确估算，保留 token/time/tool 硬限制，不宣称精确费用硬限已覆盖。
- 评测以同任务质量/工具成功率不回退为前提，对比冷/热 TTFT p50/p95、总耗时、总/未缓存输入、思考/正文输出、attempt、成本。每次仅改变一个策略假设，无用户模型预算授权时仅完成本地 fixture 和请求结构验证。

### R9 自适应思考强度

- UI 提供 auto/low/medium/high 偏好；Task 持久化用户偏好、每 step 实际档位、参数族和生效/受限原因，传至 transport，不再只在独立 helper 中存在。
- 提议 auto：提取/分类/路由使用低成本策略；复杂规划、矛盾核验、代码推导及最终一致性检查允许中高档；正文转格式不默认高档。
- 用户选择高档时仅在端点明确支持的范围内生效，仍受任务/阶段预算约束。未知或不支持则说明不可调节，不假显示“深度思考已开启”。
- 原生参数由 adapter 映射，不能将 reasoning_effort/enable_thinking/thinking budget 等当通用字段；即使基础 Gemma 模型支持 thinking，也须核验该服务网关是否开放控制及统计。
- 思考 token 与正文输出空间共同预算。策略在步骤边界选择后保持稳定，避免逐工具调用来回改档造成费用/缓存抖动；升级或检查修订受冻结上限约束。
- UI 展示简短阶段说明及用量，不要求模型输出私密思维链，也不将截图 Reasoning=0 解释为模型没有推理。

### R10 文档工具与通用执行能力

- 新工具契约：document.create({title,blocks,assetRefs,stylePreset})、document.export({artifactId,revision,formats})、document.inspect({artifactId,checks})。模型交结构化内容，受控生成器实际生成文件。
- 同一文档 revision 分别关联 MD、DOCX、PDF 和渲染预览，返回 mime/bytes/sha256/validation；仅改扩展名、文件非空或库调用无异常都不满足验收。
- 提议实现：Node 的 docx 生成 DOCX，安全受控的 HTML 打印布局生成 PDF；HTML 只能由可信 renderer 根据 blocks 构造。新增后端生产依赖、中文字体及固定浏览器运行版本须随部署清单维护，不能借用 Codex 宿主工具冒充产品能力。
- DOCX 与 PDF 要求相同内容/章节/引用和各自排版可用，不承诺两者逐页相同；如未来要求同版再评估固定转换器。
- DOCX 重新解析并渲染，PDF 重新打开提取文本/页数并渲染；检查中文字体、分页、表格跨页、图片、重叠/裁切、来源及下载权限。缺少渲染环境时报告未验证，不伪称检查通过。
- 任意图表/计算将通过统一 artifact 输入/输出扩展；常规预算表先用可信计算/文档工具。不得将模型估算表格自动标为已运行计算。
- 通用能力分层：可信文档/数据工具、隔离 compute.run、授权设备 Companion。当前本地 /api/terminal 的宿主 exec 不是沙箱，后端存在工具元数据也不等于生产已接通。
- compute.run 评估接口：language/code/inputArtifactIds/executionProfile → runId/status/exitCode/截断日志/usage/outputArtifacts；服务端固定镜像与权限，默认无网络，不挂载宿主、数据库和模型密钥，限制进程/CPU/内存/磁盘/运行时间。
- 计算沙箱需要可实际验证的隔离执行后端；Node vm 或仅 Promise 超时不是隔离/终止边界。没有执行后端时 capability 必须 unavailable，不能回退宿主执行。联网装包、外部副作用及本地文件覆盖仍遵循明确授权。
- 本轮 G1 交付为计算/Companion 接入评估和可验证准入条件，不部署沙箱；后续纵向验收建议“CSV→复算→图表→报告”，复用同一产物链路。

## Interfaces and data contracts（v2 已批准）

- 保留 `/v1`，以增量扩展现有 DTO；后端对 task/session/provider/artifact/approval 的 owner 一律来自认证身份。
- Task 创建：现有 title/intent/sessionId/images 增加 providerId、taskKind；无 providerId 使用用户默认或系统默认，无 sessionId 可建立独立会话。
- GenerationPolicy 增 reasoningPreference、有效阶段策略、outputBudget、deadline、attemptBudget 与供应商可选 cache 配置；Task 快照不保存密钥。
- Task 查询：增加有效模型快照、contextUsage、completion、plan/step 摘要和 artifactIds；原 status 字段兼容。
- 会话：增加用户自己的会话/消息读取，以及会话任务列表；提交消息和任务创建按 turnId 防重复。
- Event：保留 seq/type/payload，增加关联 ID 和脱敏摘要；事件查询支持 afterSeq。SSE 与轮询使用同一事件序列。
- Provider：认证后的列表/新增/更新/删除/默认/连接测试；密钥 write-only，公开 DTO 不返回密文或明文。
- Artifact：任务 owner 的列表、版本和正文读取/下载；引用指向本任务持久化 evidence，不能凭 artifactId 跨用户读取。
- Session ID 规范为 UUID；旧本地 ID 的映射和导入同意状态独立记录，禁止将非 UUID 直接写入 SQL uuid 字段。
- 复用既有 agent_tasks/steps/events/checkpoints/tool_invocations/artifacts/evidence、profiles 和学期/课表/例外表。新增会话/消息、审批和用户模型配置等必要表/字段采用增量迁移。
- 既有 opportunities 是共享目录，用户私有 Agent 机会用 owner 关联/扩展投影表达；不得直接把共享目录改成某个用户独占，也不另建无关联的平行机会真相源。
- Postgres 路径必须持久化图片输入引用或必要输入数据，不能在 API 接受后被 store 丢弃；本次沿用现有附件输入边界。
- TimeScheme 按学校/校区/学期生效，periods[{index,startTime,endTime}] 与真实日期/时区联合使用；ScheduleException 明确源/目标日期，旧 date 字段兼容映射需回归。
- DocumentArtifact 的 blocks/assetRefs/sources/revision 与导出格式分离，资源仅使用授权 artifact ID，不接受任意宿主路径或可执行脚本。

## Error and edge-case behavior

- 无后端配置保留明确标识的 Demo；已配置后端但不可用时显示失败/重试，不静默切换另一套数据或模型。
- 真实生产装配缺少所需持久化或凭证加密配置时明确拒绝启用相关能力；开发 InMemory 实现保持可测试并明确标识。
- 用户退出/切换账号后停止旧订阅；删除供应商后历史任务可查看模型快照，但未执行任务若凭证不可用需明确反馈。
- 截止日期按日期边界处理；无时区/学期的记录标明依据，不能伪造教学周和空闲确定性。
- 未知工具执行结果不自动盲重试；保留现有高风险审批与幂等规则。
- 任务并发、超时、恢复、重试不能重复写消息/审批/产物或重放不可重复副作用。

## Acceptance criteria

| ID | Given / When / Then |
|---|---|
| AC01 | 同用户同会话先说明学校专业年级再请求竞赛推荐，第二次真实 Worker 的 transport 输入包含身份；跨用户读取失败。 |
| AC02 | 会话经过压缩及 Worker 重建，身份和最新纠正仍保留，工具消息配对有效，其他会话信息不意外混入。 |
| AC03 | 旧本地非 UUID 会话继续可读，新后端提交使用合法 UUID；旧内容未获选择不自动上传。 |
| AC04 | API/Worker 使用独立应用上下文与同一测试数据库，写入的审批/机会/画像/证据相互可见并在重建后可读。 |
| AC05 | 选择 A/B 两个供应商提交任务，本地假上游分别收到对应 model；界面有效模型一致，不显示硬编码 DeepSeek 标签。 |
| AC06 | 保存和编辑密钥，数据库无明文；省略新密钥保留旧值；列表/日志/事件/前端无密钥；另一用户不可读取或使用。 |
| AC07 | 工具开始/结束/失败事件实时可见；SSE 断开再轮询/恢复，事件完整、顺序正确且不重复。 |
| AC08 | 刷新并打开未完成任务可续订；取消/恢复对应真实后端行为；审批与缺少材料显示不同原因。 |
| AC09 | 两个不同自然周、单双周及调课样本显示正确；一次性截止不跨周重复；未知课表不报告全天可用。 |
| AC10 | ICS/CSV/XLSX 在 Calendar 预览后确认保存；取消/校验失败不覆盖现有数据，保存后日历与 Today 同步。 |
| AC11 | 明确要求多章节长报告但模型只答“好的”、工具失败或预算耗尽，任务不能成为完整成功；差距和已有草稿可见。 |
| AC12 | 策划书依次产生提纲、草稿、检查及最终 Markdown，artifactIds 非空；引用可追踪，下载内容和持久化版本一致。 |
| AC13 | 章节执行后中断并恢复，保留已完成章节，不重复副作用；修订有上限，失败不伪装完成。 |
| AC14 | Inbox/Calendar 样板符合已选配色和层级；指定三种宽度及亮暗主题可用；长标题、键盘和全部数据状态可检查。 |
| AC15 | 本地确定性回归、假上游集成与真实模型质量分别报告；未运行的真实数据库/模型/高校验收标明未验证。 |
| AC16 | 连续请求仅更新时间/任务状态，稳定规则/工具段保持一致；首次工具摘要稳定、原文可取回，压缩后身份/约束正确。缓存实际收益另外实测，不能用哈希一致冒充 KV 命中。 |
| AC17 | 多协议 usage fixture 保留缺失/零、缓存读写及 reasoning 包含关系；429/慢 body/断流/截断测试满足总 deadline/attempt，上游不收到不支持参数。 |
| AC18 | auto 与用户 high 经 UI→Task→Worker→transport 生效，复杂阶段可升级；不支持控制的端点明确受限，预算/可用输出空间正确。 |
| AC19 | 两所学校不同节次作息、午休/晚课/非整节活动、单双周和调课准确；窄屏日/可滚动周可用，非本周参考不计忙碌。 |
| AC20 | 同一文档版本真实导出 DOCX/PDF，重新打开且内容匹配，渲染检查中文/表格/分页无截断，授权下载及哈希可核；缺渲染环境不标完整通过。 |

## Open questions

- v2 总计划及子任务阶段委托已确认，当前没有阻塞本地实施的待答偏好。
- 真实模型调用预算、生产 DB/部署和真实高校材料仅在实际需要这些外部操作时单独确认，不阻塞本地实现与确定性验收。

## TDD acceptance tests

- 先将既有红灯探针固化为正确调用层的回归：同 session 两轮输入、短回复误判成功、跨周截止和未知空闲。
- 后端新增 session-context、provider-routing、shared-state、proposal-delivery 集成用例；覆盖真实 API→TaskStore→Worker→transport，不能只测独立 helper。
- 前端增加 AgentChatPage、ProviderSettings、CalendarPage、InboxPage 的用户行为测试；覆盖事件状态、刷新续订、真实数据错误和键盘交互。
- SQL 使用本地 PGlite 契约测试，覆盖 0001、0002、0003 和本次增量迁移；测试用户/角色显式构造，不读真实凭证。
- 两个独立 app context 共享数据库的验证不称为两个独立进程测试；独立进程验收仅在明确指定隔离 TEST_DATABASE_URL 后执行。
- Playwright 覆盖身份→推荐、供应商选择、工具时间线、课表确认和策划书下载；拦截到本地假上游，不消耗用户模型额度。
- 补充 cache/usage/finish_reason/reasoning/慢响应体/嵌套重试 fixture；不把 provider 未上报 cache 或 reasoning 当成零。
- 生成文件 fixture 覆盖中文长文、跨页表格、引用、图片和用户输入特殊字符；文档重新打开、文本核对及实际渲染需全部保留证据。

## Impact assessment

- 直接影响：会话及任务协议、Worker 装配、持久化 Repository、模型解析、业务 Evaluator、Calendar 日期投影和三类产品 UI。
- 下游：Supabase profile 数据、机会雷达、课表导入、Today、审批恢复、上下文统计、旧浏览器会话和 Demo。
- 数据风险：现有 profile/个人校园画像及共享机会目录各有契约，需显式映射并复用；不能因新存储接口产生两份互不一致的事实来源。
- 安全风险：新增模型 URL/凭证和产物读取均在服务端校验 owner；连接/抓取复用现有地址防护；凭证不进入任务快照和提示词。
- 性能影响：会话检索按 user/session/turn 索引；事件增量读取；大历史先预算再压缩，不把全部历史反复送模型。
- 兼容性：任务 DTO 增量；旧本地会话保持可读；不自动迁移/清除用户数据；旧模型内置 ID 可作为兼容别名但展示名动态解析。

## Affected files and components

| 文件域 | 原因与任务 |
|---|---|
| backend/src/runtime/{store,postgres-store,worker,approval}.ts，app-context.ts，main*.ts | 共享持久化、会话读取、模型解析、验收与恢复装配；T1/T2/T3/T6，分时单一写入者。 |
| backend/src/core/{types,memory,context,context-builder,personal-context,opportunity-store,evidence,planner,evaluator,llm,cloud-tools}.ts | 复用既有契约，增量补 Repository/模型目录/产物和策划书阶段执行；按任务拆新模块避免大文件堆叠。 |
| backend/src/api/server.ts，backend/migrations/，supabase/migrations/，backend/scripts/validate-migration.ts | 新认证接口、增量 SQL、全链迁移验证；统一单一写入者和迁移顺序。 |
| web/src/lib/agent/{api-client,sessions,sessions-context,context}.ts*，lib/llm/proxy.ts | DTO、后端会话映射、实际模型、订阅事件、上下文指标；T2/T3/T4。 |
| web/src/features/agent/，features/settings/ProviderSettings.tsx | 任务时间线、审批/输入、产物及用户模型设置；T3/T4/T6。 |
| web/src/lib/domain/{calendar-grid,today}.ts，features/calendar/，features/dashboard/ | 日期与例外、空闲可信度、导入确认和 Today 接线；T5。 |
| web/src/features/inbox/，components/shared.tsx，globals.css，app/layout.tsx | Inbox 样板、主题 token、状态和响应式层级；T7。 |
| 新 core/generation-policy、provider capabilities、文档 AST/renderer 模块；llm.ts/reasoning.ts/代理及各调用点 | T9 统一请求策略/usage/缓存/思考；T10 通用文档工具与导出，移除多处参数策略漂移。 |
| 作息模板增量 SQL/DTO、课表异常映射；backend/package.json/lockfile、文档生成运行清单 | T5 节次与真实时间；T10 新生成器/固定渲染依赖和字体，仅 Phase4 按批准范围变更。 |
| 对应 *.test.ts*，web/e2e/，backend/tests/agent-benchmark/，.github/workflows/ci.yml | 正确 seam 的回归、可控 E2E 以及 scripted/real 分类；T1–T8。 |
| project.md、docs/campusmate-2.0/ 相关报告、本 Spec | Phase 4 内按实际证据更新；不能提前声明完成。 |

## Compatibility, migration, and operational impact

- 新 SQL 沿用现有项目迁移体系；Supabase CLI 先通过 --help 核验，只生成本地增量文件；不覆写已经存在的历史迁移。
- 当前 backend/migrations 与 supabase/migrations 双目录需在清单中明确加载顺序；validate-migration 现只加载 0001+0002，必须纳入 0003 及本次增量。
- 新增 schema 的自动化只针对本地隔离数据库；不能让测试隐式加载 web/.env.local 后写入真实项目。
- 数据增量以兼容扩展为主，不删除旧列/表/历史会话；新功能上线前配置要求与回退步骤单独记录。
- 生产凭证加密需要服务端主密钥及轮换版本；本地测试使用临时测试密钥，不生成或修改用户全局配置。
- DOCX/PDF 渲染增加后端部署依赖和资源用量；先核验可用包/字体许可证与固定渲染版本，缺依赖需诚实标明，不以当前 Codex 运行环境替代部署验证。
- API/Worker 分离部署的 Companion 路由限制继续明确，不能因业务共享状态修复而宣称跨进程本地工具已通过。

## Risks and mitigations

| 风险 | 限制与检测 |
|---|---|
| 上下文泄漏/会话串线 | owner 校验、复合索引、跨用户集成、账号切换及压缩回归。 |
| UI 所选与实际模型不同 | 任务配置快照+假上游 A/B 路由断言+实际返回模型展示。 |
| 秘钥误清空或泄漏 | write-only 更新语义、密文断言及日志/事件/响应脱敏测试。 |
| 后端“有模块无接线” | 实际 API→Worker 装配集成；独立 context/重建可见性验证。 |
| 长任务失控/误判完成 | 冻结验收、预算和一次修订上限、短回复/工具失败/恢复回归。 |
| 导入/日历展示误导 | 预览确认、完整日期范围、例外投影及四态页面测试。 |
| 任务并发写共享文件 | 主代理独占总 Spec/迁移/提交，依赖交付 accepted 后启动后续消费者。 |
| 缓存率提升但费用/质量变差 | 同任务冷/热对照，联合质量、时延、tokens、attempt及费用；不追单指标。 |
| 思考参数不兼容/正文被预算挤掉 | capabilities 允许 unknown；adapter 白名单映射，思考+输出共同预算，截断检查。 |
| 文档导出可下载但不可读 | 真实解析、中文字体和多页渲染检查，版本/内容/哈希一致。 |

## Test strategy and execution order

所有闸门/构建串行，工具命令固定真实 pwsh；本机 npm shim 失效，优先用现有 node_modules 的直接入口，无需重装。

1. 每个 T 任务运行最小回归 Red→Green；新测试名和命令记录进该任务提交。
2. 后端聚焦示例（cwd backend）：`node --test --test-force-exit src/runtime/worker.test.ts src/runtime/worker-evaluator.test.ts src/core/context.test.ts src/core/personal-context.test.ts src/api/stage1-runtime.test.ts`；随后执行该任务新增集成文件。
3. 后端本地回归（cwd backend，pwsh）：`$testPaths = @(rg --files src tests -g '*.test.ts' | Where-Object { $_ -notlike '*postgres-integration.test.ts' } | Sort-Object); node --test --test-force-exit @testPaths`。外部 DB 测试在 T1 改为显式 opt-in 后仍须默认无真实写入。
4. 后端类型（cwd 仓库根）：`node backend/node_modules/typescript/bin/tsc --noEmit -p backend/tsconfig.json`。
5. 迁移（cwd backend）：`node scripts/validate-migration.ts`，升级验证清单后结果必须列实际迁移版本。
6. 前端（cwd web）：`node node_modules/vitest/vitest.mjs run`；类型：`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`；构建：`node scripts/build.mjs`。
7. 确定性 benchmark（cwd backend）：`node scripts/run-benchmark.ts`，明确标记 scripted。
8. E2E（cwd web）：`node node_modules/@playwright/test/cli.js test`。先移除配置对失效 npm shim/外部模型的依赖，再使用独立本地服务；不复用会读真实凭证的代理作测试上游。
9. 实际 Preview：390/768/1440px 与亮暗主题；仅在视觉判断必需时截图，证据放仓库外，不能用单测替代。
10. 真实模型策划书质量、两进程 PostgreSQL、Supabase RLS 及高校样本分列验收，未运行就标未验证；需外部授权时在最终动作前请求。

### 已取得的基线证据（2026-11-14）

- 后端本地回归：167/167，通过；真实 DB 集成文件明确未执行。
- 前端：18 文件、100/100，通过；前后端类型检查 exit 0。
- 真实 Worker+本地假 transport 两轮探针：`SESSION_IDENTITY_IN_SECOND_MODEL_REQUEST=false`。
- 报告探针：`REPORT_REPLY=好的`、`REPORT_TASK_STATUS=succeeded`、`ACCEPTANCE_REJECTS_INCOMPLETE_REPORT=false`。
- 现有日历 helper+页面日期投影探针：`ONE_OFF_DEADLINE_VISIBLE_IN_BOTH_SELECTED_WEEKS=true`；`EMPTY_COURSES_REPORTED_FREE_MINUTES=[840,840,840,840,840,840,840]`。
- 实际窄屏 Preview：Inbox 亮边框/信息层级、Calendar 七列挤压与截断已观察；非完整视觉验收。
- 本地公开供应商元数据：DeepSeek（内置）/deepseek-chat；没有请求上游，不能据此判断真实服务模型是否 Gemma。
- 只读追加发现：SQL session_id 是 uuid，而旧浏览器 session ID 非 UUID；现迁移验证不含 0003。两项均待新增正确 seam 回归，不声称已实测线上失败。
- v2 只读证据：main/main-worker 的 system 前部含秒级时间和任务名；web chat 两处硬传 DEFAULT_REASONING=low；后端 agent-loop 调用 transport.chat 未传 reasoning；tierForTask/THINKING_BUDGET 未进入产品链路。以上是源码断点，未实测其对截图命中率/真实模型思考的因果影响。
- 其他调用缺口：响应头后即清除超时计时器；usage 只保留 input/output；未处理 finish_reason 截断；浏览器与代理可能嵌套重试。对应 T9 新回归，当前未声称已修复。

## Implementation plan（每项 Standard）

| Task | 交付与验收 | 依赖/负责人建议 | 最小 Red→Green |
|---|---|---|---|
| T1 共享状态与存储契约 | 必要 SQL Repository、UUID/owner 契约、显式隔离 DB 测试和全迁移清单；AC03/04/06 的底座 | 无；后端子代理，主代理独占迁移文件最终写入与提交 | 两个 context 的审批/机会/画像可见性和重建、UUID 写入红灯→增量 schema 与 Repository→本地引擎验证。 |
| T2 会话与个人上下文 | 服务端 session/turn/画像读取，压缩及计量，旧本地会话兼容；AC01–03 | T1 accepted；上下文子代理 | 同 session 二轮身份缺失红灯→真实 Worker 接线→重试幂等、压缩纠正及跨用户。 |
| T3 模型配置与 BYOK | 认证用户配置、加密凭证、实际任务路由、能力与模型卡片；AC05/06 | T1 accepted；模型子代理；Worker/API 写入与 T2 串行集成 | A/B 假上游选型失败和空密钥覆盖红灯→配置解析→加密/隔离/错误回归。 |
| T4 可见执行工作台 | SSE/轮询事件接续、任务重附着、正确暂停原因、取消/恢复；AC07/08 | T2/T3 accepted；工作台子代理 | 工具事件不可见和刷新丢 taskId 红灯→订阅/存储/UI→断流去重与卸载清理。 |
| T5 日历正确性与入口 | 完整日期、例外、作息模板/节次、数据四态、课表导入和 Today；AC09/10/19 | T1 accepted；日历子代理；只写其域 | 跨周截止/停课/接口失败误判空闲红灯→日期投影→不同作息/三格式预览确认和页面回归。 |
| T6 策划书执行与产物 | 阶段调度、非空验收、有限修订、通用文档 AST/持久化 MD 与授权下载；AC11–13 | T2/T3/T4/T9 accepted；后端/产物子代理，工作台单一写入者集成 | “好的”错误成功红灯→按任务类型验收→章节恢复、引用、版本和下载一致性。 |
| T7 明亮学院风样板 | Inbox 列表/预览、日历时间轴/移动议程、共享 token 和协调组件；AC14 | T4/T5/T6 accepted 后集成；前端子代理 | 依据用户行为做相称验证，不为低风险颜色写镜像单测；多尺寸/主题实际 Preview。 |
| T8 集成与证据收口 | 全回归、E2E、scripted/real 区分、project/阶段报告更新；AC15 及全 AC | T1–T7、T9、T10 committed+accepted；主代理 | 端到端身份→推荐→策划书多格式预览下载、课表确认→日历；按序跑闸门，汇报限制。 |
| T9 LLM 策略与观测 | 稳定前缀、usage/费用、总重试/超时、输出流/截断、自适应 reasoning；AC16–18 | T2/T3 accepted；模型策略子代理；共享调用点单一写入者 | 时间扰动、high 丢参、缺失 usage、慢 body 和重试乘法红灯→统一策略→协议 fixture/预算回归；真实优化收益另待模型预算。 |
| T10 DOCX/PDF 工具 | 通用 create/export/inspect、真实二进制、中文/表格/引用、渲染与授权下载；AC20；G1 计算工具评估 | T6 accepted；文档子代理；与工作台写入串行集成 | 导出/解析/分页样本红灯→可信生成器→实际文件/渲染验证；提交所需后端生产依赖与运行清单。 |

- 共用 backend/core/types.ts、API、Worker、api-client、globals.css、迁移顺序和锁文件按单一写入者协调，不能仅因任务不同就并发写。
- 在存储/DTO 基础通过验收后，T5 可与 T2/T3 独立文件域并行；测试/构建仍串行。T7 可以提前准备无写入视觉方案，功能消费者必须等依赖 accepted。
- 各任务一份主要提交，保留 Red/Green/回归证据；主代理负责审查实际 diff 与提交，只包含该任务文件。不得将全部修改积压到最终集成后再提交。
- 总计划获批后拟使用 `codex/campusmate-reliability-experience` 分支；不 push/发布。子代理阶段代理审批仅在用户一并明确授权后启用，新增目标/契约/不可逆动作仍返回用户。

## 官方资料核验（2026-11-14）

- OpenAI Prompt caching：https://developers.openai.com/api/docs/guides/prompt-caching —— 缓存复用与渲染前缀、模型/API配置有关，不能把旧模型的参数/阈值通用于未知网关。
- Claude Prompt caching：https://platform.claude.com/docs/en/build-with-claude/prompt-caching —— cache_control 与缓存读写有独立语义；总输入需按该协议组合，不直接套另一厂商 input_tokens。
- Gemma Thinking：https://ai.google.dev/gemma/docs/capabilities/thinking —— Gemma 4 的基础模型存在 thinking 控制；不证明用户第三方端点已开放同一参数或上报用量。
- Gemini Thinking：https://ai.google.dev/gemini-api/docs/thinking —— 控制字段和支持档位依模型/API变化，需 adapter 映射。
- docx 官方项目：https://github.com/dolanmiu/docx —— 可由程序生成 DOCX；模型可仅输出结构化内容，无需获得任意宿主终端。
- Playwright PDF：https://playwright.dev/docs/api/class-page#page-pdf —— 可由受控打印布局生成 PDF；实际浏览器、字体、资源预算仍是产品后端部署依赖。
- Node vm：https://nodejs.org/api/vm.html —— vm 不能充当运行不可信代码的安全隔离；现有本机 exec 不能改名作为云沙箱。

## Approval record

- 初始请求：授权检查工作区及提出改进方向；全局 AGENTS 要求实施前总审批。
- 用户偏好回复：确认明亮学院风、竞赛项目策划书场景；不扩大解释为 Phase 4 批准。
- 用户追加四点：授权继续评估与补充方案；并非 Phase4 总计划批准。v1 的“仅 Markdown”边界已被本次 DOCX/PDF 提议取代，避免新旧计划冲突。
- 2026-11-14 总审批：主代理询问“请确认是否批准这份 Spec v2 和实施计划，并授权我在计划范围内审核、推进子代理各阶段”，用户原话：“确认”。覆盖 v2 的 20 项 AC、10 项任务，本地实现、测试及逐任务提交；授权主代理审核推进范围内子阶段。无跳过阶段授权。
- 部署/发布/push、生产数据库写入、付费模型实测预算以及新目标/行为/影响扩大仍不在本次授权内。
- 用户异步确认恢复规则：同会话已有后续对话时，旧失败任务提示“用新消息继续”，保留旧任务记录；不自动创建继续任务或插回旧轮次。
- 用户要求召回子智能体并由主代理全权执行；已停止全部运行代理，后续不再派发。该执行方式覆盖历史编排要求，批准的产品范围与验收不变。
- 待记录：用户批准原话、计划版本、委托范围及任何偏差。获得批准后在范围内推进到完成，不逐任务重复索取同一授权。

## 调度状态与实施证据

| 任务 | 当前状态 | 所有者 | 依赖 | 提交/证据 |
|---|---|---|---|---|
| T1 | accepted | 本人 | v2 授权有效；各阶段已审 | e9d83d4；最终回归194/194 |
| T2 | accepted | 本人 | T1已提交并验收 | 350caed；后端218/前端104，类型/迁移/构建通过 |
| T3 | accepted | 本人 | T1/T2 accepted | 完整后端224+最终定向13，前端106，类型/迁移/构建通过；见子规格 |
| T4 | accepted | 本人 | T2/T3/T9 accepted | 后端240/240、前端114/114，类型/构建通过；真实事件/恢复/取消，详见tasks/t4-visible-workspace.md |
| T5 | accepted | 本人 | T1 accepted | 后端244+最终定向15，前端122+最终日期5，类型/迁移/构建通过；UI跨尺寸T7/T8继续 |
| T6 | accepted | 本人 | T2/T3/T4/T9 accepted | 后端253+最终相关8、前端124，类型/构建通过；分章恢复/受限AST/授权MD，DOCX/PDF在T10 |
| T7 | pending | 本人 | T4/T5/T6 accepted | — |
| T8 | pending | 本人 | 其余实施任务 accepted | — |
| T9 | accepted | 本人 | T2/T3 accepted | 完整后端236+最终相关14，前端107，类型/迁移/构建通过；真实KV收益未实测 |
| T10 | pending | 本人 | T6 accepted | — |

### T1 当前证据

- Red：聚焦 shared-state/storage-contracts 11 tests、0 pass、11 fail，exit 1；全为真实断言失败，没有缺导入或语法错误充当 Red。日志：仓库外 `campusmate-evidence/t1-red.log`。
- 独立 SQL 评审发现 private 机会子资源仍公开；新增 opportunity-visibility 真正 RLS 测试先 Red（来源预期1条，实际2条），修新增迁移策略后 Green（1 pass/0 fail）。
- 本地增量迁移由官方 Supabase CLI 3.1.0 生成；只写文件，未连库或应用生产迁移。
- 评审追加的真实 pg DATE、memory import/evidence owner、path-only/canonical artifact问题已按边界 Red→Green修复；原聚焦25/25、四版本迁移16/16和类型检查通过，真实DB集成明确未连接。
- 最终独立评审发现 canonicalArgs 丢失 JSON 自有 __proto__ 键。主代理新增两模式正文/哈希/同版本冲突回归：先2 fail（content hash mismatch），使用无原型字典修复后2 pass；类型检查exit0，最终本地后端回归194/194、0fail、exit0。未通过任意宿主文件读取绕过内容校验。
