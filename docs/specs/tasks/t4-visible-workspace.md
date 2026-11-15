# T4 可见执行与任务恢复

Status: accepted（本地）；2026-11-15；单代理。基线9d574f7，沿用已批准总Spec R3/AC07–08，不新增外部操作。

## 行为及边界

- 复用Task/Event/Checkpoint和现有会话，不建立第二个执行系统。显示真实排队、模型请求、工具开始/结束/失败、来源、检查、正文增量和产物状态；不显示私密思维链。
- 工具事件有稳定callInstanceId、原toolCallId、invocationId、耗时及脱敏摘要；同名多次可区分，来源仅安全http(s)链接。默认不展示完整参数/工具原文。
- subscribeTask维护连续seq和去重缓冲，SSE断开时同时补events(afterSeq)和task；重连刷新token且携带cursor。终态前补齐事件；卸载停止连接/定时器，拒绝迟到回调。
- ChatSession保存backendId/currentTaskId及有界本地view缓存；后端session/tasks为真相源。刷新/重登可重新加载并续订；响应按turn插回用户消息之后，恢复不重复累计token或追加同一回复。
- paused/needs_input区分审批、预算、输出不完整、保存失败及缺材料；审批决定/恢复/取消调用真实API。预算需明确修改；恢复旧failed已有后轮返回已选定的“用新消息继续，保留旧记录”。
- 首版继续在当前会话执行时阻止新发送，暂停时允许用户后续消息排队。修正store恢复规则：paused/needs_input作为顺序屏障，其后尚未执行的queued轮次不应阻止原任务恢复；用户选择的禁止改序只针对已failed旧轮次。
- 取消是协作式操作，停止后续模型/工具调用；执行中的请求可由信号中止。对于已开始的外部副作用不宣称能撤销。取消后保留记录并释放顺序屏障。
- 本地view缓存有上限，浏览器存储满不能让服务端任务被标失败；提示持久化限制。原始事件及大结果仍由后端保存。

## 影响面（基线9d574f7）

| 文件 | 改动 |
|---|---|
| backend/core/agent-loop.ts:25/155、runtime/worker.ts:133/203 | tool事件ID/耗时/摘要、await事件顺序、取消与检查点接线 |
| backend/api/server.ts:177、runtime/{store,postgres-store}.ts:100 | SSE完整轻量DTO/错误清理、恢复与取消屏障 |
| web/lib/agent/api-client.ts:140、sessions.ts:13 | 可靠增量订阅、任务列表/审批API、局部view缓存及纯合并 |
| 新web/lib/agent/task-state.ts、新features/agent/{use-task-monitor,TaskWorkspace}.tsx | 会话重附着、任务结果去重/排序、真实时间线与控制 |
| web/features/agent/AgentChatPage.tsx:93 | onEvent接通、当前任务选择、后台重附着及流式草稿 |
| 对应backend/runtime、api与web测试 | 消费者Red→Green，不用组件快照代替行为验收 |

## GWT与验收

| ID | Given/When | Then | 对应测试 |
|---|---|---|---|
| W1 | SSE重复、乱序、断线后poll、重连 | 事件连续且每seq只交付一次，带cursor | api-client订阅fixture |
| W2 | 创建任务后刷新/重新挂载 | 从backend会话关联续订，任务结果只写一次 | AgentChatPage用户行为 |
| W3 | 真实工具成功/失败、同名多次 | UI给独立过程和结果，记录有ID/耗时 | API→Worker事件+TaskWorkspace |
| W4 | paused审批/预算/缺材料 | 显示不同原因，按钮调用对应API并可读报错 | 控制/审批组件测试 |
| W5 | 工具组间取消或旧failed恢复 | 不执行余下工具；取消释放屏障；旧failed提示新消息 | memory/PGlite队列集成 |
| W6 | 卸载/账号切换后事件迟到 | 旧连接停止，不能写入新会话 | 订阅与组件生命周期 |

串行定向→完整后端→类型/迁移→前端测试/类型/构建；交互Preview与E2E在集成T8再次覆盖。真实模型、跨进程PG与部署未验收。备份v7，完成独立本地提交，不push。

## 验证与限制

- 后端类型及完整240/240通过（排除需要外部Postgres的集成测试）；前端完整114/114、类型及生产构建通过。日志在仓库外campusmate-evidence/t4-*.log。
- 浏览器开发调用路径也通过真实onActivity显示工具开始/结果，明确标为浏览器开发记录，不提供服务端恢复。正文生成不展示私密reasoning。
- 后端工具事件先持久化再执行；Postgres事件分配对任务行加锁；取消、终态事件与会话屏障提交保持一致。SSE只发送轻量DTO，避免重复传图片和原始intent。
- 完整前端回归暴露原有通知去重的到达顺序缺陷：桥接通知只加入首个匹配簇。先增加确定性红灯再修复为合拢所有匹配簇；跨轮次/跨事件原测试保持通过。
- SSE fixture改为受控时钟，覆盖乱序、重复、poll、重连cursor及终态补齐；不以不稳定的毫秒级真实等待验收。界面新增摘要与时间线的同名文案用复数查询验证。
- 生产构建仍有既有大chunk和mock静态/动态混合导入警告。浏览器多尺寸实测与复杂任务阶段事件在T7/T8继续验收；本阶段不声称已完成整体交付。
