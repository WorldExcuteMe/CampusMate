# T1 共享状态与存储契约
## Status

Phase 4 — accepted; primary commit e9d83d4, final local regression 194/194.
Standard；总 Spec v2 的 T1，覆盖 AC03/04/06 的底座，不替代 T2/T3/T6/T10 的端到端验收。
基线 HEAD：060c09b028ed0750269a8e2e9905d35663346b05；分支 codex/campusmate-reliability-experience。
恢复记录：主代理管理 v3_CAMPUSMATE_IMPLEMENT_20261114-135858；本文件 before 已获主代理成功确认。

## Problem and goal

TaskStore 已支持 PostgreSQL，但审批、证据、画像、机会各自驻留进程内存；独立 API/Worker 不能共享这些业务状态。
本任务复用现有 SQL 数据模型，提供可在独立 app context 和重建后访问的 Repository，以及后续会话、模型配置和产物的存储接口。

## Scope and non-goals

- 实现审批、证据、个人上下文、机会关联的 PostgreSQL Repository 和共享装配。
- 提供 UUID session/turn、密文配置封装、artifact 版本/owner/哈希的存储底座与本地契约测试。
- 迁移验证明确加载 0001、0002、0003 及本次增量；真实 DB 集成改成显式隔离 TEST_DATABASE_URL。
- 不写前端、API 业务端点或 Worker 会话/模型/报告执行逻辑；不触碰生产库、付费模型、部署、push、外部副作用及 Companion 跨进程 RPC。
- 不自动上传、删除或转换旧浏览器聊天；不把完整 Episodic/Procedural 长期记忆系统纳入本任务。

## Confirmed decisions and approval

- 用户“确认”批准总 Spec v2 和主代理在该计划内审核推进子阶段；本子任务由主代理按阶段放行。
- 明亮学院风和首个竞赛项目策划书不在 T1 内提前实现。
- 主代理独占总 Spec、补充备份公共索引、增量 SQL 最终写入和所有 Git 写操作。
- 所有闸门/构建串行；本子代理每次测试先申请主代理测试令牌。
- 命令使用 C:/Users/Asus/AppData/Local/Programs/PowerShell/7/pwsh.exe；不使用技能中失效的旧路径。

## Functional requirements and interfaces

1. AppContext 在 PostgreSQL 模式下为 Task、Approval、Evidence、PersonalContext、Opportunity 选用同一 SqlPool 的持久化实现；开发 memory 模式保留。
2. buildContext 支持注入测试 SqlPool；上下文重建可复用同一测试数据库；生产无 DATABASE_URL 仍明确失败。
3. ApprovalStore 复用现有接口，唯一(taskId,idempotencyKey)，决定按 userId 校验并原子 pending→approved/rejected；终态不可反转。
4. EvidenceStore 复用 agent_evidence；任务关联写入校验 task/user 一致；内部按 task 读取供可信 Worker/Evaluator，任何外部暴露仍由认证层校验 owner。
5. PersonalContextStore 的学校字段映射 user_institution_profiles，专业/年级/兴趣/技能/目标映射 profiles；写入以事务保持一致，不产生第二份完整画像。
6. 学期、课程规则、例外、导入任务沿用已有表，任何按 ID 操作同时验证 owner 和父学期/课程归属。
7. information_sources 保持全局白名单；用户信息源配置通过关联记录表达 enabled/kind/adapterId，不能用全局字段覆盖其他用户偏好。
8. OpportunityStore 保持当前 create/listByUser/get 契约；机会正文只存 opportunities，用户个人收藏/Agent机会通过 user_opportunities 关联投影；create 的Agent输入保存为私有正文。
9. 原有目录/seed默认public继续公开读；新private正文仅created_by owner可读，个人关联不向他人授权；私有content_hash带owner命名空间，不按跨用户私有正文去重。新增savePublic(userId,opportunityId)仅关联公共机会，不能关联他人私有正文。
10. SessionStore 的 create/get/list/appendMessage/listMessages/updateSummary 均带 userId；会话 ID 为 UUID，turnId/messageKey 为调用方稳定幂等键，消息按序返回。
11. appendMessage 独立保存单消息：提交方先追加 user，Worker 后追加 assistant；同(messageKey)幂等，允许同 turn 后续追加，不要求完整轮才能持久化；摘要保存 summaryThroughSeq，不能替代原消息。
12. ProviderStore 保存用户配置元数据与可选 EncryptedSecret 封装；封装只接受 algorithm/keyVersion/nonce/tag/ciphertext，省略密文保持旧值，移除凭据需明确操作。
13. T1 不负责明文加密或上游连接；T3 使用该接口完成 AES-256-GCM、主密钥、公开 DTO 和路由。持久化不提供明文回退字段。
14. ArtifactStore 复用 agent_artifacts，提供 owner 限定的 create/get/listByTask，唯一(taskId,documentId,revision)，内容版本不可变；保存 kind/inline 或 storagePath/sha256/revision/文档关联。
15. Artifact 和 Evidence 的 task/user 必须匹配；不接受跨用户 artifactId 或把外部文件路径当授权下载地址。
16. 新契约优先放 core/storage-contracts.ts；AppContext 注入 sessionStore/providerStore/artifactStore，memory 模式提供同接口实现；不擅自改共享 core/types.ts、runtime/worker.ts、api/server.ts。

## Reused schema and additive DDL list

| 来源 | 复用/增量 |
|---|---|
| supabase/migrations/0001_init.sql | profiles、information_sources、opportunities；旧机会public保持原语义，新Agent机会private并按owner限定正文。 |
| backend/migrations/0002_agent_runtime.sql | agent_tasks/steps/events/checkpoints/tool_invocations/artifacts/evidence；不改写历史迁移。 |
| backend/migrations/0003_personal_context.sql | user_institution_profiles、academic_terms、courses、course_schedules、schedule_exceptions、import_jobs。 |
| 新 agent_approvals | id/task_id/user_id/tool_name/args/idempotency_key/risk/status/created_at/decided_at；唯一(task_id,idempotency_key)，owner 索引与 RLS。 |
| 新 agent_sessions/agent_session_turns/agent_session_messages | UUID、user_id、会话标题/模式/摘要及边界序号；turn 幂等；单消息 message_key/seq/role/content/task_id；owner 与会话序列索引。 |
| 新 user_llm_providers | user_id/provider_id、显示名/协议/URL/model/capabilities/context metadata、可选密文封装、默认配置标志；owner/provider 唯一与 RLS。 |
| 新 user_opportunities | user_id/opportunity_id、用户收藏状态和时间；复合主键/owner RLS；正文引用既有 opportunities。 |
| 新 user_information_sources | user_id/source_id、kind/enabled/adapter_id/name；用户配置与全局白名单分离。 |
| agent_artifacts 增量 | revision/document_id 等查询字段或明确 inline envelope；原有 inline/storage_path/sha256 持续兼容，增加任务/owner/版本索引。 |

增量 SQL 最终文件名由主代理依已核验迁移流程创建；本子代理仅提交确切 DDL 建议，不自行写 SQL。
T1 不提前增加 task provider/policy/images 字段；后续任务在共享写入许可下增量映射，避免底座替下游决定业务快照。

## Error and compatibility behavior

- UUID 不合法在 Repository 契约边界给可读错误；旧 localStorage ID 映射及内容同步由 T2 完成。
- owner/父对象归属不匹配拒绝写入；跨用户查找返回不可见；不把数据库错误转换成成功或 memory 降级。
- 不读取 web/.env.local 为测试构造连接；没有 TEST_DATABASE_URL 的外部集成明确 skip。
- PGlite 只证明本地引擎与独立 context 契约；不声称已验证独立进程、真实 Supabase RLS 或生产迁移。
- memory 的既有 MemoryStore 保留；会话生产事实源为新增 SessionStore，T2 负责组装历史，不重复存 profile。

## Acceptance and TDD tests

- Given 两个独立 context 共享测试 SqlPool，When 一方写审批/机会/画像/证据，Then 另一方及重建 context 可读且 owner 隔离。
- Given UUID 会话与稳定 turnId/messageKey，When 分时保存 user/assistant 并分别重试，Then各消息仅一份且顺序稳定；无效 UUID 拒绝，原有本地历史不被操作。
- Given 两个用户收藏同一public机会，Then只引用一份正文且关联隔离；两用户相同private输入不跨owner去重，私有正文不可被他人/匿名读或收藏。
- Given 画像/学期/课表/例外/导入任务，Then 正确往返且跨用户父对象写入拒绝。
- Given Provider 密文封装，Then数据库无明文存储字段，省略更新保留旧封装，owner 隔离；不替代 T3 加密验收。
- Given artifact revision/内容/哈希，Then owner 可重建读取，跨用户及错配 task 拒绝，不替代文件渲染验收。
- Red：新增 shared-state/storage-contracts 测试先暴露内存装配和缺失 Repository/迁移；记录真实失败原因。
- Green：增量实现并运行聚焦测试；再跑本地后端回归、类型及全迁移清单，全部需主代理测试令牌。
- 外部集成必须显式 TEST_DATABASE_URL 和隔离 fixture 用户；本轮默认不执行。

## Files and handoff

- 新增 core/storage-contracts.ts、runtime/postgres-{approval,evidence,personal-context,opportunity,session,provider,artifact}-store.ts、runtime/migrations.ts 及对应聚焦测试。
- 修改 app-context.ts/main*.ts、validate-migration.ts、postgres-integration.test.ts；共享 types/API/Worker 若确有必要先向主代理申请归属。
- Phase 3 精确契约与影响见下；已依主代理逐阶段授权实施，实际证据见 Phase 4。
- 每次新增文件写入须已有主代理 before 成功许可；写后报告路径供 after；主代理负责最终评审/提交/验收。

## Phase 3 interface and DDL detail
- `buildContext(env,{pool?:SqlPool})`：生产无连接/注入池拒绝；同池装配，`dispose()`仅释放自建池，测试注入池由fixture关闭。main*.ts统一调用。
- `SessionStore.create({userId,id?,title?,mode?})/get(userId,id)/list(userId)`；`appendMessage({userId,sessionId,turnId,messageKey,taskId?,role,content})/listMessages(userId,sessionId,afterSeq?)/updateSummary(userId,sessionId,summary,throughSeq)`。
- appendMessage 在会话行锁内分配seq并写入turn+message；重试返回原记录，taskId存在则核对task owner及session；禁止一条messageKey改写既有正文。role/content复用ChatMessage类型，保留工具配对及多模态内容。
- `ProviderStore.upsert({userId,providerId,displayName,protocol,baseUrl,modelId,capabilities?,contextLimit?,metadataSource?,encryptedSecret?,removeSecret?,isDefault?})/get(userId,providerId)/list(userId)/delete(userId,providerId)`；默认标志更新事务化且每用户至多一个。
- `ArtifactStore.create({userId,taskId,documentId?,revision?,kind,inline?,storagePath?,sha256})/get(userId,id)/listByTask(userId,taskId)`；重复版本仅相同内容/哈希幂等，否则拒绝；哈希由服务端计算并核对，不信任调用方自报。
- 新通用底座文件：`core/storage-contracts.ts`、`runtime/memory-storage.ts`、`runtime/postgres-shared.ts`、`runtime/migrations.ts`；后者只列清单/读取SQL，绝不在生产启动时自动执行迁移。
- 七个Repository精确文件：`runtime/postgres-approval-store.ts`、`postgres-evidence-store.ts`、`postgres-personal-context-store.ts`、`postgres-opportunity-store.ts`、`postgres-session-store.ts`、`postgres-provider-store.ts`、`postgres-artifact-store.ts`（均位于backend/src/runtime）。
- 新测试精确文件：`backend/src/runtime/shared-state.test.ts`、`storage-contracts.test.ts`、`storage-test-fixture.ts`；现有测试文件仅修改`postgres-integration.test.ts`。
- DDL基础：对agent_tasks添加唯一(user_id,id)、对academic_terms/course_schedules添加唯一(user_id,id)供复合FK；对新增父表也建立唯一(user_id,id)。不改现有主键。
- agent_approvals：id uuid PK，task_id/user_id uuid NOT NULL，tool_name/idempotency_key/risk text NOT NULL，args jsonb NOT NULL，status text CHECK pending/approved/rejected，created_at/decided_at timestamptz，UNIQUE(task_id,idempotency_key)，FK(user_id,task_id)→agent_tasks(user_id,id)。
- agent_sessions：id uuid PK，user_id uuid→auth.users，title text DEFAULT 新会话，mode text CHECK auto/daily，summary text，summary_through_seq integer DEFAULT 0，next_seq integer DEFAULT 1，created_at/updated_at timestamptz，UNIQUE(user_id,id)。
- agent_session_turns：user_id/session_id uuid，turn_id text，created_at timestamptz，PK(user_id,session_id,turn_id)，FK(user_id,session_id)→agent_sessions；agent_session_messages：id uuid PK，user_id/session_id uuid，turn_id/message_key text，task_id uuid NULL，seq integer>0，role text，content jsonb，created_at timestamptz，UNIQUE(session_id,seq)，UNIQUE(user_id,session_id,message_key)，复合FK→turn及task。
- user_llm_providers：user_id uuid→auth.users，provider_id text，display_name/protocol/base_url/model_id text，capabilities jsonb DEFAULT {}，context_limit integer NULL CHECK>0，metadata_source text，encrypted_secret jsonb NULL，is_default boolean DEFAULT false，created_at/updated_at timestamptz；PK(user_id,provider_id)，部分唯一索引user_id WHERE is_default，CHECK密文封装必需字段且algorithm=AES-256-GCM。
- user_opportunities：user_id uuid→auth.users，opportunity_id uuid→opportunities，status text CHECK active/expired/archived，created_at timestamptz，PK(user_id,opportunity_id)；user_information_sources：id uuid PK，user_id uuid→auth.users，source_id uuid NULL→information_sources，name/kind text，url text NULL，adapter_id text NULL，enabled boolean DEFAULT true，created_at timestamptz。无URL的群信息源允许source_id NULL。
- opportunities新增visibility text NOT NULL DEFAULT public CHECK(public/private)，private要求created_by NOT NULL；替换opp_read为visibility=public OR created_by=auth.uid()，保留旧目录公开语义；user_opportunities的owner读亦要求正文public或归该用户，服务端savePublic只允许public。private hash以owner+正文构造，保留旧全局唯一索引。
- agent_artifacts：新增document_id uuid DEFAULT gen_random_uuid() NOT NULL、revision integer DEFAULT 1 CHECK>0；UNIQUE(task_id,document_id,revision)，复合FK(user_id,task_id)→agent_tasks；agent_evidence同样追加复合task-owner FK，已有artifact引用写入时核对owner/task。
- 新表全部启用RLS：客户端owner只读，不授予凭据表读取策略；服务端写入仍做owner检查。关联/会话/时间/任务序列按上述唯一键及(user_id,created_at)/(task_id,revision)索引；机会策略按visibility兼容收紧，不将新私有正文放进原全局可读面。
- SQL最终写入前由主代理核对列/约束命名和历史数据兼容；约束新增不删除/回填业务历史，遇不一致只报告，不擅自清洗生产数据。

## Phase 3 impact and ordered test plan

- 直接影响装配与SQL Repository；API/Worker既有接口不变，下游通过新增stores消费。memory新增stores语义对齐Postgres；旧MemoryStore继续存在。
- 顺序：主代理生成增量SQL及before许可→新增正确seam Red测试→观察装配/缺表失败→Repository/DDL/装配Green→同任务聚焦/类型/迁移→本地后端回归→父代理审查提交；无依赖消费者提前启动。
- 聚焦（cwd backend）：`node --test --test-force-exit src/runtime/shared-state.test.ts src/runtime/storage-contracts.test.ts`；新测试不导入load-env，不读取真实凭据。
- 类型（cwd仓库根）：`node backend/node_modules/typescript/bin/tsc --noEmit -p backend/tsconfig.json`；迁移（cwd backend）：`node scripts/validate-migration.ts`，必须输出全部版本。
- 回归（cwd backend）：`$testPaths=@(rg --files src tests -g '*.test.ts'|Where-Object{$_ -notlike '*postgres-integration.test.ts'}|Sort-Object); node --test --test-force-exit @testPaths`；显式外部集成默认skip单独检查，绝不自动连库。
- 所有命令仅Phase4取得父代理串行令牌后执行；PGlite构造两组显式UUID fixture用户及非owner数据库角色，测试共享/重建、父owner、私有机会RLS/去重/public收藏、分时消息幂等、artifact版本及memory/Postgres接口一致性。

## Phase 4 implementation and evidence

- 用户要求召回子代理后，由主代理单独完成最后评审修复。canonicalArgs改为无原型字典，确保JSON自有__proto__参与哈希；新增memory/Postgres正文回读、哈希及同版本冲突测试先2fail后2pass。最终类型检查exit0，本地回归194/194、0fail、exit0（此前192为修复前记录）。

- 授权：用户“确认”批准总 Spec v2/10任务/阶段委托，“继续工作”延续执行；主代理已逐项批准 T1 Phase 1/2/3，并授权本收口代理接续已有 Red→Green，不重启规划。
- 已实现七个 PostgreSQL Repository、同 SqlPool 装配、memory 对等会话/供应商/产物接口、显式完整迁移清单及显式隔离数据库测试入口。API/Worker/core/types.ts 未在 T1 改写。
- 直接修改/新增文件：`backend/src/core/storage-contracts.ts`、`core/personal-context.ts`（jobs 可见性供受验证子类检查）；`backend/src/app-context.ts`、`main.ts`；`backend/src/runtime/{memory-storage,migrations,postgres-shared,postgres-approval-store,postgres-evidence-store,postgres-personal-context-store,postgres-opportunity-store,postgres-session-store,postgres-provider-store,postgres-artifact-store}.ts`；`backend/scripts/validate-migration.ts`；`backend/src/runtime/{shared-state,storage-contracts,postgres-date,opportunity-visibility,postgres-integration}.test.ts`、`storage-test-fixture.ts`；本子 Spec。增量 SQL `supabase/migrations/20261114061420_campusmate_shared_storage.sql` 由主代理独占写入。
- 原新增契约 Red、独立 context Green 7 项以及机会子资源 RLS Red→Green 1 项由前执行阶段留存；本收口重新核对 `C:/Users/Asus/CodeBuddy/campusmate-evidence/t1-boundary-red.log`：17 项中 8 pass / 9 fail，失败为真实 pg DATE 映射 3 项、path-only 信任 2 项、JSONB 键序哈希 2 项、memory evidence 引用 1 项、memory import 接管 1 项，均为预期行为断言。
- 边界 Green：SQL DATE 使用驱动本地年月日（不先转 UTC）；inline JSON 经持久化 JSON 规范化、递归键排序后计算 SHA-256，array 顺序保留；path-only 在没有可信内容读取器时拒绝；memory evidence 校验同 owner 同 task artifact；受验证 memory import 更新要求 owner 且禁止改 term，只接受状态/计数/版本更新。
- Artifact 限制：T1 只核验 inline 内容；storagePath 仅可作为元数据，不能凭路径或自报哈希接受文件、授权下载。文件 bytes/hash/导出/渲染由后续受控文档任务实现，不能将本存储测试视作文件验证。
- 串行聚焦（cwd backend）：`node --test --test-force-exit --test-concurrency=1 src/runtime/shared-state.test.ts src/runtime/storage-contracts.test.ts src/runtime/postgres-date.test.ts src/runtime/opportunity-visibility.test.ts` → **25/25 pass，0 fail**，exit 0；13.57s；`t1-focused-green.log`。exec session 54707 已结束。
- 类型（cwd 仓库根）：`node backend/node_modules/typescript/bin/tsc --noEmit -p backend/tsconfig.json` → 无诊断，exit 0；`t1-typecheck.log`。
- 迁移（cwd backend）：`node scripts/validate-migration.ts` → 0001/0002/0003/20261114061420 全部 `MIGRATION_APPLIED`，**16 pass / 0 fail，MIGRATION_VALIDATED**，exit 0；`t1-migration.log`。
- 本地回归（cwd backend）：`$testPaths = @(rg --files src tests -g '*.test.ts' | Where-Object { $_ -notlike '*postgres-integration.test.ts' } | Sort-Object); node --test --test-force-exit --test-concurrency=1 @testPaths` → **33 文件，192/192 pass，0 fail/skip**，exit 0；18.27s；`t1-regression.log`。
- 外部集成默认入口（cwd backend）：清空当前命令子进程的 `TEST_DATABASE_URL` 后运行 `node --test --test-force-exit src/runtime/postgres-integration.test.ts` → **1 skip，0 fail，未连接数据库**，exit 0；`t1-external-skip.log`。原 CRUD 断言保留，没有读取 .env 或退回 DATABASE_URL。
- 日志均位于仓库外 `C:/Users/Asus/CodeBuddy/campusmate-evidence/`；全部测试持有主代理独占令牌且串行，无真实数据库、密钥或付费模型调用，无新安装、部署、push 或子代理 Git 写操作。
- 观察影响：独立 app context 和重建通过同池共享状态，private/public 机会及其来源/报告/证据的本地角色隔离保持；既有 192 项回归无失败。PGlite 不证明真实 Supabase RLS、分布式并发、生产迁移或 API/Worker 下游完整闭环。
- 当前状态：`ready_to_commit`；测试令牌已交回主代理，等待独立评审/新鲜验证及 T1 主要提交；尚无 T1 实现提交，不能声称 committed/accepted，不能放行依赖 T1 的 T2 实施。
