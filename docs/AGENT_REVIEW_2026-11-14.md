# Agent 深入复核 · 2026-11-14

最初审查阶段只做模拟执行，没有修改 Agent 业务逻辑。最初反例使用进程内 Store、脚本化 transport 与计数器工具，没有调用付费模型、执行主机命令或连接私人数据/云端数据库。后续模型烟测和首批代码修复分别记录如下，不能与最初审查混为一谈。

## 已执行反例

| 问题 | 观测 |
|---|---|
| 默认验收假成功 | 工具明确返回 error，模型随后声称完成；任务仍 succeeded，certificate.passed=true |
| 工具预算按轮而非逐调用检查 | toolCalls 预算为 1，同轮实际执行 3 个工具，之后才标 budgetExceeded |
| 取消不及时 | 第 1 个工具内请求取消，第 2 个不同参数工具仍执行，最后状态才变 cancelled |
| 单 Worker 并发未兑现 | concurrency=2，两个待执行任务，观测同时运行最多 1 个 |
| 服务端会话历史断开 | 同 user/session 连续两任务，第 2 次模型输入不包含第 1 次用户消息 |

审查采样当时的本机公开供应商目录：configuredModelCount=0。这只是当时快照，不能据此断言用户未接入模型；14:39 复查已存在 t1dp / deepseek-flash 配置且有服务端 Key，并完成一次真实模型请求（详见下节）。上述运行时反例仍为脚本化 transport，不代表真实模型回答质量评测。
本机原始结果：仓库外 campusmate-agent-review-2026-11-14/probes.json。

## 后续修复：invalid_tools 连接误报

- 根因：共享代理限制 tools 最多 16 个；上游 Agent 当前定义 18 个，普通 `hi` 会携带 17 个，本地即返回 400 invalid_tools，尚未请求供应商。不是 API Key 未配置。
- 修复：有界上限改为 128，保留 body/token/超时/限流及函数名、参数对象、重复名称校验；不裁剪工具来掩盖兼容问题。400/413/415/422 分类为请求错误，不重试/备用端点，不再误报连接失败。失败回复标为执行失败，不贴规则提取 Mock 标签。
- Demo 提示修正：业务数据本地存储与模型配置独立；Demo 不意味着 AI 必定 Mock。
- 2026-11-14 14:39 本机实际验证：保持用户现有配置，POST /api/llm，providerId=t1，17 个真实 Agent 工具定义，输入“只回复OK，不调用任何工具。”；HTTP 200、model=deepseek-flash、content=OK、0 个工具调用。供应商报告 prompt_tokens=1989、completion_tokens=2。未执行主机工具，未读取/输出 Key；此结果证明当前供应商通路可用，不是全能力 Agent 验收。
- 139 项单元测试最终通过；12 项 E2E 全部通过（包含新增 2 项浏览器协议 fixture），build 与 Deno check 通过。一次全量单测曾遇到既有 dedupe 合并测试 1/2 的偶发失败，未改去重业务代码，重跑通过；这不属于此次模型连接修复。

## 根因与处理优先级

1. **P1 默认验收**：worker.ts defaultAcceptance 返回 []，defaultEvaluate 降到 !result.mock。需要业务验收条件与真实持久化/证据验证；工具失败和流程异常不得因模型可达而通过。
2. **P1 共享状态**：app-context.ts 中只有 TaskStore 可切 Postgres，审批/证据/记忆/课表/机会仍 InMemory；API 与 Worker 各自装配后，状态不共享且重启丢失。
3. **P1 会话**：前端 history 仅供 runChat 兼容分支，runTaskViaBackend 仅提交 sessionId；Worker 组装 history=[]、userProfile=''，没有加载同会话历史。需要消息存储与按 user/session 装配，不能把 sessionId 标签当记忆实现。
4. **P1 预算与取消**：agent-loop 每轮开头检查预算；每个 native tool 调用前没有预算/取消门控。Worker 在循环结束才读取 cancelRequested，withTimeout 不会取消底层 Promise。需要逐调用检查、取消信号向模型/工具传递、恢复时累计已用预算。
5. **P1 兼容路径权限/可信度**：浏览器 runChat 可直接请求本地 terminal/fs/write 等端点，未经过 Runtime 的逐工具审批；verify_opportunity 仍可接受模型自报 VERIFIED。Host/Origin 检查不等于用户审批。生产需统一执行边界或明确关闭这些兼容能力。
6. **P2 并发**：worker.tick 在 for 循环中 await executeTask，concurrency 实际表示串行批量数量；需要有界并发队列而非简单改用无界 Promise.all。

## 静态风险（尚未做完整崩溃故障注入）

- Worker 的 appendEvent/writeCheckpoint/renewLease 使用 void，写入不被等待；持久化失败可能脱离任务状态机。
- 工具副作用先执行，随后才 recordInvocation；崩溃发生在两者之间时存在重放窗口，不能仅凭成功结果缓存宣称 exactly-once。
- checkpoint 包含 usage，但恢复只传 messages/repeat，runAgentLoop 又从 EMPTY_USAGE 开始；重启恢复可能重置预算统计。

修复顺序：收紧验收与高危工具边界 → 逐调用预算/取消 → 服务端会话上下文 → 共享持久化/恢复一致性 → 真并发与真实环境回归。

## 首批执行层修复（已落本地代码，尚未完整接入所有前端路径）

- `agent-loop.ts` 增加结构化 stopReason 和 toolErrors；Native/JSON 工具共享失败判定，`error`、`ok:false`、`success:false` 都不能计为成功动作。未知工具、非 JSON 对象参数不执行。
- Worker 在业务 Evaluator 前加不可绕过的执行门控：异常、预算停止、轮次上限、虚构工具结果、任何已观测工具失败都不能得到成功证书，包括自定义 Evaluator 错误放行的情况。显式 required 验收条件缺少验收存储时不再退化成“模型可达”。
- 当前采用保守策略：本轮任何工具失败即阻止成功认证，即使模型随后给出总结；业务失败恢复/重试后是否可完成，后续应由明确条件和产物核验判定。没有业务条件的普通文本任务仍只是执行基线，不能据此宣称业务目标被独立验收。
- 每个 LLM/工具边界检查持久化取消标志与预算；多工具同轮逐个检查，计入尝试次数；额度用完不再额外调用付费模型总结。恢复时沿用 checkpoint/Task 的累计 tokens、toolCalls、costUsd、wallMs，不清零。
- Event、checkpoint 和 checkpoint 续租改为 await；写失败停止后续调用。检查点消息深拷贝，避免之后的循环修改已存内容；心跳拒绝被捕获并阻止后续执行。
- 新增 15 项执行层回归：三工具预算 1、首工具内取消、模型等待期间取消、不同失败格式和异常、强制成功 Evaluator、缺少业务验收存储、恢复用量、检查点失败/等待、非法工具参数、轮次上限等。backend `typecheck` 通过；184 项测试中 183 通过、1 项真实 Postgres 集成因未配置数据库跳过。测试使用 fixture，无付费模型/真实主机副作用。

### 明确未修完的边界与下一批

1. **取消在途任务**：当前阻止下一次调用，不会强制终止正在运行的命令/工具或撤销副作用。后续传递 AbortSignal 到 transport、Companion RPC 与子进程执行器，测试取消/超时后的进程退出和无延迟写入。单次 LLM 响应可能已消耗超过剩余额度；需加输出额度预留/供应商 token 上限，不能把事后门控称为绝对费用硬上限。
2. **审批统一**：浏览器兼容路径和后台 Runtime 应共享服务端门控。审批绑定 user/task/工具/规范化参数摘要、期限与单次消费；未配置审批存储时高危工具必须 fail closed。先做未审批不能执行、改参旧审批失效、跨用户拒绝等回归，再接 UI 确认；只弹浏览器确认框不够。
3. **服务端会话上下文**：增加按 `(userId, sessionId, seq)` 隔离的消息存储；Worker 从服务端加载前轮消息、画像与限定记忆，不再只接收 sessionId 标签。测同会话连续两任务能引用前轮、换用户不可见、重启不丢。
4. **共享持久化与崩溃窗口**：审批、证据、记忆、课表、机会需要 Postgres 实现并让 API/Worker 共用数据库；checkpoint/事件/任务状态提交与副作用幂等仍需事务和故障注入。当前仍不承诺 exactly-once；未执行云端迁移。
5. **业务验收与并发**：将 planner 的业务验收条件真正冻结到 Task，并从真实产物/存储核验；concurrency 仍串行，后续用有界工作池并验证真实同时执行上限、租约隔离和无重叠 tick。

上述代码修复针对 `backend` Task Runtime；Demo 的浏览器 `runChat` 不是同一个执行循环，需要后续统一门控，不能因为 backend 测试通过就宣称全部 UI 路径同步修完。现有 5173/8787 页面与模型代理未改，模型配置保持原样，未 commit/push/发布。

## 第二批：服务端会话历史（用户选择先修第 2 项）

**已修复同会话第二个 Task 缺少前轮输入的问题。** 不新增第二套消息表，复用已持久化的 `agent_tasks.intent/result/error/status` 作为用户/助手轮次的事实来源；原始 `task.queued` 事件的 identity 用于稳定提交顺序（即使同毫秒提交也不依赖随机 UUID 排序）。因此既有 Runtime schema 即可使用，没有新增迁移、没有修改云端库；必须保留创建任务时的队列事件，不能归档删除后仍期待完整历史。

- `TaskStore.listSessionHistory` 在 InMemory 与 Postgres 两种实现中都强制校验当前 Task 的 owner/session；前轮记录也必须同时匹配 userId 和 sessionId，客户端猜中别人的 sessionId 不会得到其消息。
- 只加载当前 Task 之前提交且已经结束的轮次；排除当前、未来、queued/running/needs_input 等未结束任务。失败/取消答复有显式状态前缀，不被当作成功工具事实。
- 默认最近 12 轮、硬上限 20 轮，单条长消息截断，总历史不超过 48,000 字符；成对保留用户/助手，再通过 Context Builder 预算裁剪送给模型。不加载工具原始输出，不把历史消息提升为系统指令，不接收客户端伪造 history/userId。
- Worker 不再丢弃 Context Builder 组装出的历史；不依赖 MemoryStore 的内存 session 缓存。若已有 checkpoint，直接恢复其中冻结的上下文，不重复拼接历史或当前输入；Task 重试仍对应一条轮次，不重复追加。
- 已存在的 UserMemory 画像/偏好现在也会按当前 userId 有界注入；画像 MemoryStore 本身仍是内存实现，**这不等于长期画像/全部记忆已经完成共享持久化**。
- API 现在校验 sessionId 为 UUID，intent 为字符串，保持内存与 Postgres 行为一致。用户身份仍只来自 JWT，不信任请求体 userId。

### 当前验证

- 新增 7 项内存契约/Worker 回归、1 项真实 PostgreSQL 引擎（PGlite）API→Worker→独立 Node 子进程磁盘重开回归；包含跨用户同 sessionId、不同会话、前后轮顺序、未来消息排除、失败标记、历史限长、恢复不重复、重试单轮与重启读回。
- backend typecheck 通过，192 项测试中 **191 通过、1 项外部 Postgres 集成跳过**；组合迁移验证仍为 19/19。测试 LLM 为 fixture，未做付费模型质量评测，不是云端 Supabase 双账号 RLS 验收。
- 当前会话历史随所选 TaskStore 生命周期：Postgres 可跨进程/重启；开发 InMemory 模式不能跨重启。浏览器 Demo 原有本地历史路径没有改动，也不会自动导入旧浏览器会话到后台；没有发布或宣称所有记忆已经持久化。
