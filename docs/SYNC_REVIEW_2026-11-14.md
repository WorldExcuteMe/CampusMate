# 上游同步与优化复核 · 2026-11-14

## 同步范围与保护

- 本地 main 从 `453514a` 快进到上游 `060c09b`（PR #4）；保留上游 Agent Runtime 2.0、课表/日历、会话、附件、新 UI、重试/上下文系统。
- 原有未提交修复没有覆盖丢弃：已保存完整 tracked diff + untracked 副本，并保留 stash `1c08ea522d44db7165619cf6d2844610660f8913`（`local-fixes-before-upstream-sync-2026-11-14`），没有 drop/pop。
- 备份目录在本机仓库外 `C:/Users/HP/.codex/visualizations/2026/11/13/01a1d2ac-ce6b-7aa0-9b20-31deeccdfeb2/campusmate-sync-2026-11-14/`。
- 手工处理 14 处冲突，保留 UUID、首次建档、会话/查询缓存隔离、模型来源标识与鉴权 Function；对新页面改用会话 Repository Context，对已登录用户保留后端机会 Store 装饰器。
- 未 commit/push、未改远程可见性、未执行云端 migration、未跑 QQ/微信私人数据摄取。

## 已执行优化

| 项 | 修改与验证 |
|---|---|
| 前端隐私隔离 | 聊天存储按账号分区；长任务计划/滚动记忆按账号+会话分区。旧无身份聊天仅作为 Demo 兼容数据，不导入真实账号 |
| Demo 确定性 | seedState 使用深拷贝，修复首次写入修改模块级种子导致 reset 后残留/测试污染 |
| 生命周期 | SSE 服务端终态/断线清理计时器并防 tick 重入；前端完成后取消 10 分钟兜底、停止后不新建 SSE/轮询；Companion stop 清理已排队重连 |
| Windows 测试 | 取消 Node --test-force-exit；此前全量出现 libuv closing 断言，修复计时器后普通 node --test 已能稳定自然退出 |
| 本地监督器 | dev/start:all 共用监督启动器，传递端口参数、健康探测、区分复用/自有代理、正常退出清理自有子进程、崩溃重启限次；Python 探测/文件夹 UI 改为按需而非启动时探测/预热 |
| 本地接口 | 所有本地工具入口增加 Host/Origin 检查，坏 JSON 返回 400 不崩溃，网页抓取复用服务端 URL/DNS/重定向/字节上限守卫；模型接口复用共享 handler，保留 reasoning/tool_choice，避免前后端重试次数相乘 |
| Runtime API | 限制请求体，校验 JSON 对象/主要工作流字段，调用者只能降低不能抬高默认任务预算，query token 仅允许 SSE 路径，内部异常不向访客返回堆栈/数据库信息 |
| 首屏包 | 页面 React.lazy + Suspense；入口 JS 由同步后未分包的 926.31KB 降至 642.09KB，gzip 274.86KB → 185.79KB。是入口包大小而非全站总下载量，未宣称实测首屏耗时提升；仍有 >500KB 警告 |
| 测试与 CI | 保留上游 backend CI 与本地 Function check；E2E 截图继续用 test.outputPath，适配新版设置页标签和可配置测试端口 |

## 实测结果

| 检查 | 结果与边界 |
|---|---|
| web npm ci | 锁文件安装通过 |
| web npm run test | 130/130，通过，24 个文件 |
| web npm run build | tsc + Vite 通过；入口 642.09KB，保留主包警告 |
| web npm run check:function | Deno 2.9.6 检查生产/本地入口通过 |
| web Playwright | 6/6，通过，本机 Chrome；模型接口使用 fixture |
| backend npm ci / typecheck | 通过 |
| backend npm test | 169 项：168 通过，0 失败，1 项真实 Postgres 集成因无配置跳过 |
| PGlite 组合迁移 | 19/19；实际执行 0001 + 本地 profiles/provenance 修复 + 上游 runtime 0002 + personal-context 0003，含画像回填/新用户触发器/重复升级不覆盖资料 |
| backend benchmark | 30/30，确定性脚本化 fixture，不是真实模型成功率或真实高校泛化证据 |
| Node HTTP smoke | 新本地代理启动、模型路径兼容、坏 JSON 后继续服务、跨源拒绝、私网目标拒绝通过；未执行真实 host terminal/摄取 |
| 本地浏览器 smoke | Dashboard/校园日历/设置三页渲染，pageerror=0；本机 dev + local API 保持运行在 5173/8787 |

PGlite 使用 Supabase Auth/角色桩，不能替代真实 Supabase RLS、生产网络、认证、崩溃恢复或付费模型验收。

## 后续优化（本轮未冒进重写）

### P1：多个业务 Store 仍为进程内内存，不支持真正的 API/Worker 分离

证据：`backend/src/app-context.ts:40-46` 无论 TaskStore 是否为 Postgres，approvals/evidence/memory/personalContext/opportunityStore 都是 InMemory；`main-api.ts` 和 `main-worker.ts` 各自 buildContext。

影响：重启丢失相应数据；分进程时审批决策、机会写入、Companion 连接等不能只靠共用 DATABASE_URL 共享，任务状态持久化不等于业务全持久化。

建议：先补共享审批/证据/机会/个人上下文 Store 与跨进程 RPC/Companion 分派，再验收生产 API+Worker 拆分。不要把单进程内测试当作多进程生产证明。

### P1：浏览器兼容核验工具仍可接受模型自报 VERIFIED

证据：`web/src/lib/agent/chat.ts` 的 verify_opportunity 把参数 status 映射为报告状态；服务端 Runtime 已有独立 Evaluator 门控，但这个兼容路径没有等价保证。

建议：生产默认使用 Runtime；兼容路径的模型状态只作为提案、降级 UNVERIFIED，必须经服务端独立证据核验再提升状态。

### P2：校园日历截止项未按选中周过滤

证据：`CalendarPage.tsx:34-45` 只将 dueAt/deadline 转星期，然后无条件加入 buildWeekEntries。切换教学周时，同一截止项会重复显示到其他周。

建议：以学期起始/选中周生成明确日期区间，再筛选任务/机会；同时接入已建模的 ScheduleException，补跨周/跨月/单双周测试。

### P2：上线前补真实环境验证与进一步拆包

- 双账号 RLS、真实 JWT/JWKS、生产路由、迁移执行、独立 API/Worker、多 Worker 崩溃恢复都仍需真实环境。
- 本地全权 host 工具只可在用户本机授权开发场景使用；不把 localhost 代理暴露公网。跨站防护不等于逐工具用户审批。
- 请求 schema 目前是基础验证，仍需统一完整嵌套 schema、课表导入错误恢复与配额。
- 主入口仍 642KB，可继续按实际依赖图拆公用 UI/认证/数据层；不为消除警告盲目配置 vendor 切块。
