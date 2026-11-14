# T2 会话和个人上下文
## Status

Phase 4 — implemented and locally verified; T1 accepted at e9d83d4; single-agent implementation.
Standard；总 Spec v2 的 R1、AC01–03；基于 e2e31df 实施，用户已明确旧 failed 恢复规则。
全部子代理已召回；本文件下方的交接/测试令牌文字仅保留原规划背景，不再构成等待条件。

## Verification record — 2026-11-14

- 原子turn接受/冲突、同会话屏障、两轮真实API→Worker、过时租约、native及JSON审批恢复、保存失败暂停，分别在内存/PGlite验证；未调用真实模型。
- Worker读取个人画像与同会话历史，保存完整transcript和连续seq摘要；压缩保留身份与最新纠正，不跨未来/近期消息空洞。
- 新增认证session接口、UUID映射及turn重试；旧正文留本地。会话、计划、记忆按owner/session隔离，组件切换与迟到回调有回归。
- 后端完整回归218项，前端104项通过；两侧类型检查、五版本迁移16项检查、前端生产构建通过。Vite保留既有大chunk/静态动态双重import提示。
- 真实PostgreSQL跨进程、真实Supabase RLS、真实模型与浏览器端到端未验收；T4继续刷新重附着和时间线，T3/T9继续已知窗口/供应商计量。未知窗口现在如实显示未知。
- 摘要是带seq的原文片段而非推断性长期画像；不自动覆盖profiles。原始历史未删除，未上传旧聊天，未部署/推送/执行远程迁移。

## Problem and goal

浏览器有历史而后端只收到当前输入；Worker 未读取会话/画像，累计 usage 被误作窗口占用。
将认证 API、共享存储、真实 Worker 与浏览器会话接通，保持身份、纠正、原始工具交互与恢复一致。

## Scope and non-goals

- 包含 session/turn 原子提交、共享队列顺序、transcript/checkpoint、分层上下文/压缩、旧 ID 映射和 promptUsage。
- 不实现 T3 供应商、T4 时间线/刷新重附着、T6 策划书、T9 调用策略，不新增自动画像学习或模型摘要调用。
- 不自动上传旧内容/改 profiles、不改 T1 已生成 SQL；主代理独占增量迁移、总 Spec、备份公共记录与 Git 写入。
- 不访问真实库/付费模型，不部署、push；真实 PostgreSQL 并发验收保留显式隔离库准入。

## Confirmed decisions

- 用户“确认”批准 v2 总计划和范围内阶段委托；“继续工作”延续，Phase1 无新增用户决策。
- owner 只取认证 sub，sessionId/turnId 新提交用 UUID；所有会话、画像、任务读写校验 owner。
- 冻结 T1 `SessionStore.create/get/list/appendMessage/listMessages/updateSummary`，复用其消息 envelope，不另起会话系统。
- 主代理允许 T2 在 T1 committed+accepted 后最小调整 `runtime/memory-storage.ts` 共享状态/原子方法；不做半提交隐藏任务。
- 同会话按接受顺序执行；paused/needs_input 阻塞后轮，取消/失败只有完成有效交互写回后才释放。
- 指定 shell 为 `C:/Users/Asus/AppData/Local/Programs/PowerShell/7/pwsh.exe`；覆盖技能失效的 Program Files 路径。

## Functional requirements

1. Task、turn 关联、唯一 user 消息和 queued 事件同事务接受；同 turn 同规范化输入返回原任务，不同输入报冲突。
2. 不同 turn 依会话锁分配 turnSeq；跨 Worker 的 claim 不得越过更早未结束或 transcript 未提交轮次，跨会话保留并发。
3. Worker 首次运行读取 owner profile 和此前已提交轮次；当前 user 仅一次，未来排队轮次不能混入 history。
4. 历史按 turnSeq、轮内 seq 组装；不能直接按会话 seq 排序，因为后一 user 可先于前轮 assistant 落库。
5. checkpoint 恢复直接使用其 messages/repeat/累计 usage/transcript cursor，不再次拼接历史或当前 user；待完成工具组先续完。
6. 原始 assistant、tool_calls、完整工具结果和最终 assistant 在裁剪/compaction 前经 awaited hook 保存；JSON 回退标为工具交互。
7. 记录稳定轮内 cursor，原始 transcript 与对应恢复 checkpoint 原子保存；重认领不能因压缩后下标重排而重复或冲突。
8. final/失败/取消先完成 transcript 提交屏障，再持久化终态及释放顺序；持久化失败保持可恢复且不假成功。
9. runtime system/时间/task/预算和重复提醒不写成用户消息；工具调用与结果作为整组压缩，未完配对不发给下一轮模型。
10. profile、带来源 seq 的身份/纠正原文、历史摘要、近期交互、任务状态及当前输入分层；最新明确用户纠正优先于旧摘要。
11. 原始历史保留；summaryThroughSeq 只推进已提交的连续前缀，不能跨当前/未来排队 user 的 seq 空洞，也不重复近期消息。
12. 旧非 UUID 会话及内容继续本地可读；按 userId+localId 建 UUID 映射，仅上传映射后新提交，刷新/登录不导入旧正文。
13. Demo 与真实用户会话/plan/memory 使用 owner 隔离键；切换账号停止旧订阅、清理内存引用并防迟到回调写入新账号。
14. promptUsage 为当前请求 inputTokens/contextLimit/outputReserve/source，累计 task.usage 单列；未知为 null，估算标 estimated。

## Interfaces and data contracts

- `POST /v1/sessions` 创建 UUID；`GET /v1/sessions`、`GET /v1/sessions/:id/messages?afterSeq=`、`GET /v1/sessions/:id/tasks` 仅 owner。
- `POST /v1/tasks` 增 turnId；成功返回 taskId/sessionId/turnId/status/deduped，客户端重试复用同 turnId；无会话旧调用仍兼容。
- 新 `TaskStore.createSessionTask`：规范化 input+sessionId+turnId → `{task,deduped}`；同事务检查 owner、锁会话、查 hash、分配 turnSeq、写 Task/user/event。
- 新 `saveTurnProgress`：taskId/userId/workerId/attempt+原始新增 transcript+checkpoint → 持久化 cursor；先验证有效 lease，再原子写入。
- 新 `finishSessionTurn`：同 lease fence+最终 transcript/status/result/usage → 原子提交和 transcriptCommitted；不得用通用 updateTask 绕过屏障。
- `claimNext` 只认领无较早阻塞 turn 的 queued/过期 running；lease owner+attempt fence 拒绝过时 Worker 写回，内存/PG 同消费者契约。
- user messageKey=`${turnId}:user`；其余=`${turnId}:transcript:${ordinal}`，ordinal 取原始执行 cursor；SQL 实际唯一键是 owner/session/messageKey。
- `Task` 增 turnId/turnSeq/transcriptCommitted/promptUsage；`CheckpointState` 增 transcript cursor/待完成工具状态，旧 checkpoint 可读。
- `AgentLoopHooks` 的 transcript/checkpoint 允许 Promise 且每次 await；最终普通回复及预算收尾回复亦必须入 transcript。
- `promptUsage.source=reported|estimated|unknown`；只用已知配置作上限，未知端点不靠模型名称宣称真实窗口；T3/T9 后续提供有效能力配置。
- 映射仅存 owner/localId/backendId/legacyNotImported，正文留在旧本地记录；profile 从 `personalContext.getProfile(userId)` 读取，空值允许继续。

## Error and edge-case behavior

- 非 UUID/无效输入 400、无认证 401、未知会话 404、跨 owner 403、同 turn 输入冲突 409；历史读取失败不能降级为空历史。
- 已接受输入不可被网络重试覆盖；同会话等待态如实显示，paused/needs_input 依现有恢复/取消能力处理。
- 旧 failed 释放顺序后已有后轮时，用户已选择“提示用新消息继续，保留旧任务记录”；返回明确冲突原因，不重新排入旧轮次或自动创建继续任务。
- transcript/summary/checkpoint 保存失败保留原始记录及恢复点；不能 catch 后直接标 failed 并让下一轮读缺失历史。
- 身份/约束/当前输入及完整必要工具组已超窗口时报告限制，不无声删除强制保留内容；空画像不引用 Demo 或他人画像。

## Acceptance criteria and TDD acceptance tests

- AC01：认证 API→共享库→真实 Worker 假 transport 两轮，第二轮含学校/专业/年级及既有 profile，当前问题出现一次；跨 owner 拒绝。
- AC02：强制压缩/大工具输出/最新纠正后重建 Worker，原始 transcript 未被截断、工具配对有效、身份/纠正仍在请求中。
- AC03：旧非 UUID 历史仍可读，新提交为 UUID；捕获请求证明无旧正文上传，账号切换隔离且旧订阅停止。
- 追加：同 turn 并发/冲突/事务故障回滚、不同 turn 顺序、暂停前轮、取消/失败提交屏障、lease 过期重认领与过时写回拒绝。
- 追加：checkpoint 不重拼、交错 seq 历史排序/摘要边界、JSON 工具来源、窗口与累计用量及 unknown 展示；旧 failed 恢复用例待选择后补定。

## Open questions

TaskStore/DDL 原子性和顺序技术方案已冻结；旧 failed 恢复分支已明确，当前无阻塞本地实施的待答问题。

## Impact assessment

- 直接：TaskStore 事务/调度、Worker 恢复/上下文、API owner DTO、浏览器会话映射与占用展示；影响 R1/AC01–03。
- 下游：T3 在 Task 快照/Worker 路由、T4 在 session/task 关联/订阅、T9 在 promptUsage/transport hooks 处接续，共享文件串行移交。
- 不把本地 PGlite/内存测试称为真实跨进程保证；PG 的会话锁、唯一约束、队列谓词与 fence 均由 SQL 契约和隔离库测试覆盖。

## Affected files and components

| 精确路径（花括号逐一展开） | 作用 |
|---|---|
| `backend/src/core/{types,agent-loop,context,context-builder}.ts` | Task/checkpoint/hooks、原始记录、身份要点与压缩；原测试 `agent-loop-context.test.ts`、`context.test.ts` 回归。 |
| 新 `backend/src/core/session-context.ts`、新 `backend/src/core/session-context.test.ts` | 会话投影、profile/纠正来源与前缀边界；复用现有 context builder。 |
| `backend/src/runtime/{store,postgres-store,memory-storage,worker}.ts` | 原子提交/进度/终态、同会话调度与两种存储共同状态；T1 交接后才写。 |
| 新 `backend/src/runtime/session-turns.test.ts`、新 `backend/src/runtime/worker-session.test.ts` | memory/PGlite 同契约、事务注错、API→Worker 两轮/重建/压缩/故障。 |
| `backend/src/runtime/{store.test,postgres-store.test,postgres-integration.test}.ts` | 原队列兼容与显式隔离 PG 的多连接 claim/fence；保留 opt-in。 |
| `backend/src/api/server.ts`、`backend/src/api/api.test.ts`、新 `backend/src/api/sessions-api.test.ts` | owner session API、turn 提交/冲突与旧无会话调用兼容。 |
| `backend/src/{app-context,main,main-api,main-worker}.ts` | 共享内存状态、SessionStore/PersonalContext 注入两个真实入口。 |
| `web/src/lib/agent/{api-client,sessions,sessions-context,memory,chat}.ts`（sessions-context 实为 `.tsx`） | DTO、owner 本地键/UUID 映射、订阅清理、Demo memory scope。 |
| `web/src/features/agent/AgentChatPage.tsx`、新 `web/src/features/agent/AgentChatPage.test.tsx` | 新提交/turn 重试与请求计量，保留原附件 payload、账号卸载与迟到回调保护。 |
| `web/src/lib/__tests__/api-client.test.ts`、新 `web/src/lib/__tests__/sessions.test.ts`、新 `web/src/lib/__tests__/sessions-context.test.tsx` | 请求体无旧内容、owner 隔离与组件生命周期。 |
| 主代理 `supabase/migrations/<CLI生成>_campusmate_session_turns.sql`、`backend/src/runtime/migrations.ts` | 增量 DDL/完整加载顺序；T2 只提供需求，不代写 SQL。 |

## Compatibility, migration, and operational impact

- 主代理生成新的本地增量文件，顺序在 `20261114061420_campusmate_shared_storage.sql` 之后；不改旧迁移、不应用远程库。
- 必要 DDL：`agent_sessions.next_turn_seq integer not null default 1 check(>0)`，分配顺序时锁 owner+session 行。
- `agent_tasks` 增 `turn_id text`、`turn_seq integer`、`input_hash text`、`transcript_committed boolean not null default false`、`images jsonb`、`prompt_usage jsonb`。
- turn_id/turn_seq/input_hash 旧任务全空兼容；新轮次三者完整、session_id 非空、turn_seq>0；input_hash 是规范化已接受执行输入的 SHA-256。
- 必须 `unique(user_id,session_id,turn_id)`、`unique(user_id,session_id,turn_seq)`；FK `(user_id,session_id,turn_id)`→`agent_session_turns`，nullable 旧任务不强绑不存在的 session。
- claim 索引至少 `(user_id,session_id,turn_seq)`，谓词阻塞较小 turn_seq 且未终态或 transcript_committed=false；无 turn 旧任务保留原调度。
- PG create/progress/finish 均仅用同一 transaction client 直接写，禁止在已持 session 锁时调用另开 pool 事务的 SessionStore；避免死锁/连接池耗尽。
- 内存 TaskStore/SessionStore 共用可控状态及临界区/回滚，同样通过消费者验收；仅持久化模式承诺跨进程；复用已有依赖，无安装需求。

## Risks and mitigations
- 后轮 user 提前写入导致乱序/摘要污染 → turnSeq 投影及连续提交前缀测试；messageKey 不含 turn 会冲突 → 多轮断言。
- 裁剪后保存/void checkpoint 导致原始工具输出丢失 → compaction 前 awaited 原始 hook+恢复 checkpoint 同事务，终态屏障故障注入。
- 过时 Worker、暂停插队、重认领重新拼接 → lease fence、顺序谓词、cursor/usage 恢复与 resume 冲突回归。
- 账号串线/旧历史上传/假精确占用 → owner 键与请求捕获、订阅生命周期测试、promptUsage/null 标签；T3/T9 不提前冒充完成。

## Test strategy and execution order

仅列待执行命令；当前测试令牌属于 T1，以下测试/类型/构建均不得现在运行。所有命令串行，先新断言 Red 再最小实现 Green。
1. cwd `backend`：`node --test --test-force-exit src/runtime/session-turns.test.ts src/api/sessions-api.test.ts`，先证原子/顺序断言红灯，再 Green。
2. cwd `backend`：`node --test --test-force-exit src/runtime/worker-session.test.ts src/core/session-context.test.ts src/core/agent-loop-context.test.ts src/core/context.test.ts`，补两轮身份/原始工具/恢复红灯再 Green。
3. cwd `web`：`node node_modules/vitest/vitest.mjs run src/lib/__tests__/api-client.test.ts src/lib/__tests__/sessions.test.ts src/lib/__tests__/sessions-context.test.tsx src/features/agent/AgentChatPage.test.tsx`，映射/隔离/计量 Red→Green。
4. cwd `backend`：`$testPaths = @(rg --files src tests -g '*.test.ts' | Where-Object { $_ -notlike '*postgres-integration.test.ts' } | Sort-Object); node --test --test-force-exit @testPaths`；随后 `node scripts/validate-migration.ts`。
5. cwd 根：`node backend/node_modules/typescript/bin/tsc --noEmit -p backend/tsconfig.json`；cwd `web` 依次 `node node_modules/vitest/vitest.mjs run`、`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`、`node scripts/build.mjs`。
6. 可选真实 PG：仅主代理提供明确授权的隔离 `TEST_DATABASE_URL` 后，在 cwd `backend` 执行 `node --test --test-force-exit src/runtime/postgres-integration.test.ts`；未提供记未验证，绝不读真实 .env。

## Implementation plan
1. T1 提交验收和文件交接 → 主代理迁移/加载清单 → 原子 turn/队列/故障 Red→Green；旧 TaskStore 调用保留。
2. awaited transcript/checkpoint/终态屏障 → API/Worker 两轮身份与 profile → 压缩纠正/工具组/重建恢复 Red→Green。
3. UUID 映射/认证 owner 本地状态/无旧历史上传 → 真实 promptUsage 与累计 usage 分开 → 聚焦与完整回归串行。
4. 主代理检查实际 diff、证据及未验证项后独占 T2 主要提交并 accepted，再交接 T3/T4/T9；本计划本身不代表实施完成。

## Approval record

用户“确认”覆盖总 Spec v2 与阶段委托；原 Phase2 已审，主代理本轮明确允许 Phase3 更新，before 已成功。
原规划的文档交接已完成；用户后续要求主代理全权执行，覆盖原委托安排。以上验证由主代理串行完成。
