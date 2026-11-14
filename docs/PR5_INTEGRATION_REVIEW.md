# PR #5 审查与集成记录

2026-11-15；范围为 PR 变更及与本地 T1–T10 的重叠实现。主代理独立完成源码审查、冲突处理及验证，没有委托子代理。本记录是工程审查，不是独立渗透认证。

## 基线及审查范围

- 原 PR：[coco38622/CampusMate #5](https://github.com/WorldExcuteMe/CampusMate/pull/5)，head `aa89e3d057b3c7e8fa167e00220236a8e59988cc`，目标 develop；功能提交 `6a0621c`。
- 抓取时 main：`060c09b028ed0750269a8e2e9905d35663346b05`；develop：`b51deced3a5f4ff075cdae176d0f4be3922a9e5e`（落后 main 32 个提交）。原 PR 的 288 个 changed files 含已进入 main 的历史；真正相对 main 的增量为 136 文件、+7043/-785。
- 本地基线 `6697163`，T1–T10 已通过本地验收；整合分支 `codex/integrate-pr5-main-20261115`，采用保留双方祖先的 merge，解决 30 处内容冲突。
- 同事 fork 未开放 maintainer 修改，因此另提集成 PR；不改写原分支、不 force push、不直接推受保护分支。快照版本 `v13_PR5_INTEGRATION_20261115-070000` 本地留存。

## 发现与处置

| 级别 | 触发及影响 | 集成处置与证据 |
| --- | --- | --- |
| P1 | 原有执行链只认 `error`，`ok:false` / `success:false` 可被记成工具成功；模型正常短答及自定义 evaluator 可掩盖失败 | 采用 PR 的结构化失败判定，并接入 invocation、事件和最终不可绕过的 execution gate；审批/预算 pending 仍按原恢复协议处理。`backend/src/core/tool-result.ts`、`runtime/worker.ts`、`core/task-events.ts`；execution-guards 回归覆盖自定义 evaluator、失败及取消。 |
| P1 | 轮次用尽仍生成收尾答复，或模型直接输出 `<tool_result>`，会混淆真实工具产出 | 轮次用尽明确 round_limit；伪造结果明确 invalid_output；均不能签成功证书，也不在轮次限制外再付费调用一次模型。`core/agent-loop.ts` 及 execution-guards。 |
| P1 | 兼容浏览器核验工具接受模型传入 VERIFIED，不满足后端独立核验边界 | 模型自报 VERIFIED 降为 UNVERIFIED；不会制造独立 evaluator 或依据。`web/src/lib/agent/chat.ts`、chat-tools 回归；保留后端 VERIFIED 触发器及原子 RPC。 |
| P1 | 整文件采用旧聊天/存储实现会丢失完整 transcript、turn 屏障、provider 快照、审批和文件恢复 | 官方 Worker 继续使用 SessionStore 的原始记录；PR 的已结束任务历史投影仅用于未注入 SessionStore 的兼容 Worker。保留 owner/session/anchor 校验及 PG 重启验证。 |
| P1 | 整合后的模型代理可能重新引入明文供应商增删接口 | 新凭证仍走认证 Runtime 的 AES-GCM BYOK；本地代理只读旧配置，不提供保存/删除回调，移除明文保存函数。生产 Function 不启用本地上游豁免。`web/dev/llm-proxy.mjs`、ProviderSettings 保留 T3。 |
| P2 | 模块级可变 Repository、旧 getSession 响应和共享 QueryClient 会在登录切换时读取旧用户数据 | 采用 PR 的 RepositoryContext、订阅优先及旧响应屏障、按 owner 重建 QueryClient；把我们新增 Inbox/日历/Agent/Today 调用点全部接入 useRepository。两组 Auth 测试均保留。 |
| P2 | 非法 JSON、过大请求、非流接口 query token、无限制初始预算 | 采用有界对象读取：非法 JSON 400、超限 413；query token 仅允许 GET task stream；新任务预算限制在默认上限，显式恢复沿用原受限增额规则。`backend/src/api/server.ts`、input-validation 回归。 |
| P2 | 旧的两个文件迁移测试和五文件本地启动清单无法证明 T1–T10 与 PR SQL 能共同工作 | 全部组合迁移使用九份显式清单；保留已使用的本地迁移版本名。PGlite、重启存储及原子 report/evidence RPC 回滚/幂等测试通过；没有操作真实数据库。 |
| P2 | 第七天的 date-only 截止被按当前小时过滤掉，ISO 时间任务不进逾期/临期视图 | Today 使用学校日的结束边界；Task ISO 时间换算为北京日，机会日期继续严格 date-only。增加跨 UTC 午夜回归，保留今天截止文案。 |
| P2 | BrowserProvider 解析失败后规则降级沿用真实来源标签；Demo 中真实提取又被一律标 Mock | 降级明确 mock-fallback，保留真实已消费 usage；展示优先 extractionMock，不能用数据容器 Demo 标记代替提取来源。config 的 provider 延迟导入另修复循环初始化。 |

## 重叠功能取舍

| 功能 | 最终选取 |
| --- | --- |
| 会话、记忆及恢复 | 保留 T2 原始 transcript、画像纠正、顺序屏障、UUID 及 owner 隔离；PR 旧结果投影只作兼容。 |
| 模型接入/思考/缓存 | 保留 T3/T9 加密配置、实际模型名、能力驱动 reasoning、稳定前缀、预算/重试/nullable usage；吸收 Function 共用 handler 和认证 transport。兼容 runChat 也接收 reasoning 和 AbortSignal，不恢复锁死常量。 |
| 进度与复杂任务 | 正式后端继续 T4 真实事件、poll 补拉、刷新、取消/恢复；兼容 runChat 采用 PR 的实际进度卡，增加会话归属及失败终态，不能冒充持久恢复。保留 T6/T10 分章、AST、MD/DOCX/PDF 真实字节导出。 |
| 课表、Inbox、Today | 保留 T5/T7 暖白学院风、课表语义和 Inbox 双栏；采用独立滚动导航、操作提示、完成/撤销确认及逾期管理，补齐日历/Today 的 Repository 上下文。 |
| Markdown/群同步/核验 | 采用 PR 安全 Markdown/GFM，禁 HTML、危险链接及自动外部图片；群去重按 owner/group 隔离；报告和依据单 RPC 原子保存、失败明确。 |
| 工程设施 | 合入本地 Docker/Auth/REST 脚手架、固定 Deno 检查、按路由加载及 CI；不自动运行 Docker、远端迁移或付费模型。 |

## 本地验证证据

命令串行执行，Node 24.21.0；PowerShell 路径为 `C:\Users\Asus\AppData\Local\Programs\PowerShell\7\pwsh.exe`，版本 7.6.9。逐字日志在仓库外 `C:\Users\Asus\CodeBuddy\campusmate-evidence\pr5-*.log`。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| Backend typecheck + 全量 node:test | 288/288，0 fail、0 skip | pr5-backend-full.log；typecheck 单独执行成功 |
| Web Vitest 最终全量 | 48 文件、218/218 | pr5-web-final.log |
| Web 类型检查及生产 build | 通过；主 chunk 587.47 kB，仍有 >500 kB 提醒 | pr5-build-final.log |
| Deno 2.9.6 check 两个 Function 入口 | 通过 | pr5-function-check.log |
| 九份组合迁移 | 16/16，MIGRATION_VALIDATED | pr5-migration.log |
| Demo Playwright | 22/22 | pr5-demo-e2e.log |
| Runtime Playwright | 5/5；身份→推荐→策划书、三格式下载、课表确认、旧任务恢复、BYOK、三宽明暗 | pr5-runtime-e2e.log |
| 确定性 benchmark smoke | 30/30，BENCHMARK_PASS | pr5-benchmark.log；夹具结果，不代表真实 LLM 成功率、耗时或费用 |

旧浏览器用例同步了中文文案、模型选择器可访问名称及规范会话存储键；保留真实行为断言。完成/撤销测试改为点击后等待异步保存；未把产品过期规则改弱来通过测试。

## 剩余风险与发布边界

- `npm audit` 记录 10 条上游依赖告警（4 moderate、4 high、2 critical，见本地 pr5-npm-audit.json）；包含现有 Vitest/Tinypool、Zod、Vite 等。未证实是产品可利用漏洞，亦未全部修复，不声称依赖零风险；跨大版本升级应单独评估。[Tinypool advisory](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3)、[Vitest advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)、[Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)，查证日期 2026-11-15。
- 本地代理的主机工具仍是受本机 Host/Origin 限制的兼容开发能力，不等同正式后端的 Companion 授权与审批。不能对公网开放该本地代理。
- Worker.tick 的并发调度仍有串行限制；本次未扩大为调度器重构，不能用 WORKER_CONCURRENCY 参数宣称吞吐已线性扩展。
- 没有运行 Docker、真实 Supabase/PostgREST/Auth/RLS、远程迁移或付费模型。PGlite/HTTP 夹具不能替代这些验收，也不能证明真实 KV 命中率、写作质量或高校数据真实性。
- GitHub main/develop 均要求 build-test 和 1 名审批；main strict 且管理员也不能绕过，develop 管理员豁免未使用。按 `.github/CONTRIBUTING.md` 走集成 PR → develop → main 发布 PR。CI、外部审批、真正 main 构建应逐层记录，不能相互替代。
- main push 会触发现有 Release workflow（构建并创建 GitHub Release）；Sites 公开发布仍需另行人工操作。本次不手工发布 Sites。
- 当前本地验证完成；远端 PR/CI/审批及 main 精确 SHA 构建状态以本次交付和 GitHub 检查为准，不能把本集成分支构建标成 main 构建。
