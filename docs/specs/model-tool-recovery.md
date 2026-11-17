# Gemma 工具执行回归修复

2026-11-15，基线 0fda748。用户报告竞赛收集任务两次只返回工具指令，第三次超时，要求恢复 Agent 实际工作。沿用此前允许的修复与本机验证范围，单代理 spec-tdd-workflow + workspace-backup；没有仓库/祖先本地 AGENTS.md 或 agent.md，适用聊天中的全局契约。用户召回代理覆盖默认委托规则。本次不 push、合并或更改云 schema。

## 证据与目标

云只读记录：52fedac5、ae904e5c 两任务为 succeeded，均无 tool.called，分别返回多一个闭括号的 JSON 和 Gemma tool token；dec39083 单次模型请求 180008ms 超时。快照均 builtin/Gemma，接口能力全部 unknown。假 transport 最小复现退出 1：两种工具文本均 toolCalls=0、rawToolProtocolDelivered=true、stopReason=completed。

目标：模型请求工具→实际工具执行→观测回传→最终来源答复；不能把未解析指令判成功。补已知 Radeon Gemma 自动参数适配，区分输入/能力/超时/取消，保留预算、owner、幂等和原始会话。未知 API 不凭名称宣称能力，不能静默换模型或丢图片。不以增加默认超时修复。完整多厂商探针和原生其他协议不属于此紧急回归修复。

## 影响面（基线定位）

| 路径 / 符号 | 基线位置 | 改动 / 影响 |
| --- | --- | --- |
| core/agent-loop.ts parseJsonTool、runAgentLoopInternal | 71–88、229–322 | 委托有界纯解析；损坏指令修复一轮或明确失败；禁止工具指令作为最终产出 |
| core/llm.ts DeepSeekTransport.chat | 40–120 | 已知端点能力、主 system 合并、结构化错误；保持单 deadline 与重试拥有者 |
| core/providers.ts ProviderService | 17–100 | builtin/BYOK 同一已知 profile 解析；保留凭证和版本检查 |
| core/generation-policy.ts generationPolicy | 14–18 | Radeon 嵌套思考参数，未确认不虚报可调 |
| core/errors.ts LlmTransportError | 53–67 | 增错误原因元数据，旧调用方兼容 |
| runtime/worker.ts defaultEvaluate | 126–127 | 不把协议/能力/超时/工具错误统称模型不可达 |
| features/settings/ProviderSettings.tsx | 13、27、90–106 | 已知能力自动解析；去掉普通表单能力输入，显示来源/能力状态 |
| 新增 tool-protocol.ts、model-capabilities.ts 和测试 | 新增 | 解析与 profile 为纯函数；无新依赖或模型自述探测 |

## GWT 与红绿计划

| ID | Given / When | Then | 不变边界 / 测试 |
| --- | --- | --- | --- |
| R1 | 用户提供的多余闭括号 JSON、Gemma token 调用 | 执行已注册 web_search 恰一次，观测回传后再答复 | 同名工具白名单、argumentError、真实事件/幂等仍走 tracedTool；Worker 集成 |
| R2 | 未闭合/未知/多重/恶意表达式或工具指令伪装最终输出 | 不执行猜测参数；最多修复一次，仍坏则 invalid_output，任务 failed | 不 eval，不伪造成功；解析单测和 Worker |
| R3 | Radeon 官方端点 + Gemma，未填写能力 | builtin/BYOK 自动采用图像/原生工具/SSE/max_tokens/嵌套思考契约 | 任意其他端点同模型名保持 unknown；profile、routing 单测 |
| R4 | 未知图片能力 / 明确不支持 | 未知允许实际端点尝试，明确不支持给能力原因 | 不丢图、不换供应商；Transport 单测 |
| R5 | 模型超时、取消、本地能力或协议错误 | 原因可区分；验收不能写成已证明网络不可达 | 保留实际 attempts、usage、deadline；错误/Worker 单测 |
| R6 | JSON 回退附加工具协议 | 合入首个 system，避免不兼容的第二条 system | 原始消息不被修改，稳定工具顺序；请求体断言 |
| R7 | 设置页保存/编辑连接 | 无需填写底层能力；保留已有密钥和配置，自动能力显示清楚 | owner、认证、默认选择和配置版本保持；UI 测试 |
| R8 | 同一竞赛查询真实模型与搜索工具 | 至少一次真实搜索及观测回传，不返回原始工具协议；有来源或明确搜索失败 | 限时限轮，不写入用户业务数据、不重放旧任务；本机真实模型 smoke |

先写 R1/R2 Worker、R3/R4/R6 Transport 红灯，最小实现后定向绿灯；串行完整后端/类型、相关前端/类型与生产构建。实际工具结果不能由假 transport 代替；真实模型 smoke 另外记录。用户随后明确授权直接使用本 API 做对话及 Agent 调优，真实验证无需另行请求。

真实模型第一轮已完成两次搜索与一次可用合作方网页读取；一处抓取失败。诊断设定的45秒单次限时截断末轮答复，任务正确 paused，不能记成功。继续以更贴近应用的限时及简短信息收集交付验证；不修改应用默认180秒。实测同时发现模型把历史赛程表述为当前开放，因此在既有稳定system补明确的时效与简洁交付规则（system-prompt.ts:2），AgentChatPage.tsx:361 同步识别新的嵌套思考适配类型。

真实第二轮75秒正常返回，但只进行了四次搜索并要求用户重新提供赛事全称，未满足收集目标，不能用 succeeded 代替内容验收。独立复核同一搜索工具：长查询返回全国征兵网等无关结果；相同Bing端点使用完整实体精确短查询可返回赛事官网。新增 R9：搜索工具保留原查询，依据实体相关性过滤明显无关结果；相关性不足时仅追加一次精确实体查询，共享原12秒总超时。输出实际查询/请求数/警告，不能把无关或零结果解释为赛事不存在。影响 cloud-tools.ts:106–144 和新增纯 web-search.ts；先以固定HTML复现红灯，再真实引擎/真实Gemma复核。不得硬编码本赛事链接或答案。

新增 R10（基于真实第一轮的抓取失败）：普通信息收集允许一处 web_fetch 失败后采用其他已实际取得的网页，但仅在后续抓取2xx、正文非空且最终答复引用该成功URL时计为已恢复的只读错误，并明确显示读取失败提示。用户明确要求的URL、未被后续来源替代的错误、写入/未知工具错误继续阻断成功；不重放副作用。原始失败事件、调用计数与resume中无法对应原始记录的错误数保留。修改仅 AgentLoop 的最终未解决错误计量，不降低工具授权或源证据要求。

第四轮按应用180秒/8192输出上限验证，最后一次响应耗尽180007ms，仍为paused而非成功。复核Radeon messages契约只确认首条system，当前native路径尚未合并Worker的稳定指令与动态日期/目标等多system，故R6扩展至已知Radeon native路径；其他端点保留既有消息语义。普通信息收集默认先给约400字、最多6要点，日期状态与来源优先，明确长文不受此默认约束。不能把诊断时的1536输出上限导致截断与应用180秒耗尽混同；均保留原始证据。

第五轮完整工具清单验证：单system使日期结论开始正确标为2026赛事已结束，但末轮仍在工具模式中长篇输出，180015ms被截断。因此新增R11：普通、未要求长文/核验/规划/写入的信息收集，在取得2xx非空网页正文后进入首轮摘要阶段；关闭该次请求的工具列表，使用write阶段/最多1024输出token和明确的6条单句交付规则，沿用原deadline/总预算。长文、复杂规划及写入任务不走此路径。仅在真的取得网页后切换，不能用空搜索或失败抓取强制收尾；摘要阶段返回工具指令不得执行或记成功。真实模型继续验证完整交付，不把局部修复或模拟测试称任务通过。

第六/七轮出现另一实际协议故障，已保存脱敏wire控制信息：同一响应的独立工具ID被流解析器按相同index拼接，工具名变成web_fetchweb_fetch，参数为多个JSON串。下一轮上游HTTP200/SSE返回BadRequest `Assistant tool call function.arguments must be valid JSON.`，但readSse忽略error帧，误成空截断。新增R12：llm-stream.ts按稳定ID区分调用、index只作当前增量路由，不拼接完整ID；支持标准不同index和实际同index不同ID；error帧形成真实结构化错误，[DONE]后停止读取而非等待连接EOF。新增真实控制帧等价回放测试先红后绿，并重新用真实API验收，不归因为用户取消或模型不支持工具。

第八轮完整模型已finish_reason=stop，实际读取西安交通大学通知且输出227token摘要，但模型把通知内的官网入口写成最终来源，未照抄实际读取页URL，导致R10仍计未恢复。复核修正：来源归属由执行器依据真实web_fetch观测绑定，不能完全依赖模型自行抄对URL。R11摘要指令明确列出成功读取页；模型漏引时由执行器补充“本次实际读取来源”清单，再评估已恢复只读错误，同时提示失败链接仅作入口。R10用户必读URL、未取得任何替代正文和写入错误边界不变。区分赛前通知计划与赛后实际结果，不把计划截止日说成实际决赛日。

## 判断、风险与回滚

竞争解释：工具服务失败会产生 tool.called/error，本次没有；上下文丢失不能解释两种明确工具文本都被判 completed；上游超时独立于解析漏报，180s 记录证明耗尽模型请求预算，不能声称已查明上游内部原因。先修本地可复现缺口，再实测上游。

解析只接收独立工具 envelope，支持严格 JSON 和有限 Gemma 对象语法，不执行代码、不从网页/工具观测提取指令。拒绝不完整、多重及危险键；无法可靠恢复就反馈模型修复。真实调用继续经工具授权/参数/预算门控。旧失败任务保留，用新消息验证；任何已有副作用不得重放。

官方依据（2026-11-15）：https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4 明确 tool_call/token、字符串 delimiter；https://amd-aim.github.io/radeon-cloud-docs/zh-cn/models/gemma-4-31b-it/ 明确图像、工具、SSE、max_tokens 与 chat_template_kwargs.enable_thinking。仅匹配已知真实端点，不泛化为所有 Gemma 部署。

回滚以本地 scoped commit 或 v16 原始快照为准；不删除会话或云数据。保持 Windows 5176/8787/8788 结构，重启只操作确认归属的后端。状态：accepted local（执行恢复与回归通过；模型事实质量边界保留）。

## 已完成的真实验证

- 原两格式最小复现由RED转GREEN，均实际调用测试工具一次并基于观测答复；Worker、错误恢复、SSE和搜索回归已定向通过，完整闸门结果另记。
- 用户授权的真实图片请求：Gemma识别7319及红色圆形，1次请求49355ms。
- 第九轮完整工具集、真实API和真实网络检索：原始竞赛收集提示，5次模型请求，4次真实工具调用，128824ms，末轮stop，状态succeeded，已读取高校通知并列出URL，失败读取明确提示。没有用户业务数据写入。
- 此通过是执行闭环，不将模型对赛前计划日期的叙述视为独立事实验收；赛后结果、其他Key/网关及KV收益仍未证明。模型仍会对计划/实际作推断，保留此质量风险，不用任务状态替代事实判断。

## 最终检查与定位

- 后端全量：320 tests / 319 pass / 0 fail / 1显式外部DB skip，45472ms；类型通过。前端219/219、类型和生产构建通过；只有既有bundle大小提示。
- 后端与前端日志：工作区外`model-tool-backend-regression.log`、`model-tool-web-regression.log`、`model-tool-web-build.log`。真实API证据`live-gemma-task-smoke-20261115-v9.json`；真实图片`live-gemma-vision-20261115.json`。原最小复现及失败wire诊断均保留。
- 最终符号：tool-protocol.ts parseTextToolCall:14；model-capabilities.ts resolveModelCapabilities:13；llm-stream.ts readSse:19；agent-loop.ts recoveredFetchErrors:128、摘要阶段:256；worker.ts executionFailure:36。基准表保留原始位置，不混为当前行。
- 确认无queued/running任务后重启归属本工作区的8788；认证模型列表自动能力与postgres模式、5176页面200已实测，密钥未回传。无schema/历史/主密钥变更；旧任务用新消息继续，不重放。
