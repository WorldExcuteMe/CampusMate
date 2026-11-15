# 当前待修复问题复核 · 2026-11-14

**后续修复状态：第 1、2 项已修复，第 3～5 项仍待处理。** 第 1 项为群同步账号作用域隔离；第 2 项改为数据库原子保存报告/依据，错误不再被吞掉，失败时聊天停止续写并标记执行失败。以下审查复现输出保留为修复前证据，不能再据此判定前两项仍存在。具体实现、真实 Docker PostgreSQL 验证与权限边界见 TEST_PLAN 最新章节。

本轮为审查，不修改业务代码，不执行用户历史通知合并，不变更数据库或账号。用户暂缓的 Agent 权限确认不在本轮修复范围。以下问题均有当前源码定位及隔离复现，不能与此前已修的聚类顺序依赖混为一谈。

验证方式：Node + Vite SSR 加载当前模块，使用独立内存 localStorage/Repository/Supabase 返回值 fixture；另用新建 Chrome 上下文访问当前 5173 页面。没有使用用户账号或已打开浏览器，没有请求真实 QQ/付费模型；认证失败请求被拦截为 fixture。未重新跑全量单测或数据库集成，不把这些探针当成生产环境完整验收。

## 1. [已修复，原 P1] 群通知同步的去重记录未按账号隔离

- 位置：`web/src/lib/ingest/qq.ts:27,79,85-89,127`。
- 根因：所有 Repository 共用 `campusmate.group.seen`，未包含登录用户/数据源作用域。
- 复现：同一个内存浏览器存储中，向独立 A、B Repository 同步完全相同的未来竞赛通知。A 的 Inbox/机会各新增 1 条，B 自己无记录却返回 skipped=1、Inbox/机会均 0。
- 实际输出：`A={inbox:1,opportunity:1,skipped:0}; B={inbox:0,opportunity:0,skipped:1}`。
- 影响：同一浏览器从 Demo 切换到真实账号、或 A 退出换 B 后，B 会漏同步。不是跨用户数据库读取泄露，而是浏览器去重状态污染。
- 修复方向：稳定的 Repository/当前用户作用域去重键；旧的无归属键不得直接继承给某个真实用户。补 Demo/A/B 切换与失败重试测试。

## 2. [已修复，原 P1] 核验依据写入失败仍返回报告保存成功

- 位置：`web/src/lib/data/supabase.ts:200-224`。
- 根因：报告 insert 检查 error，但 evidence_items insert 的 `{ error }` 被忽略，最后仍返回原始报告对象。
- 复现：注入报告 insert 成功、依据 insert 返回 `42501` 拒绝的 Supabase fixture。调用顺序为 verification_reports → evidence_items，方法最终 resolved-success，未抛错。
- 影响：上层可能显示核验报告保存成功，实际依据没有落库；刷新后报告与依据不一致。
- 修复方向：检查每步错误，明确报告/依据原子保存或失败补偿机制；不得仅让 UI 提示成功。补依据失败及部分成功重试测试。

## 3. [P2] 日历的截止条目没有按真实日期归属周

- 位置：`web/src/features/calendar/CalendarPage.tsx:31-46`，`web/src/lib/domain/calendar-grid.ts:17-19`。
- 根因：页面只把 dueAt/deadline 转成星期数字，传入条目已丢失具体日期；buildWeekEntries 仅过滤课程周次，直接拼入所有截止项。完成任务、已归档机会也未区分展示状态。
- 浏览器复现：隔离 Demo 中设置一条 2099 年未来任务、一条 2020 年已完成任务、一条 2020 年已归档机会。第 1 周和点击下一周后的第 2 周，三个条目都各出现 1 次。
- 实际输出：`week1={future2099:1,done2020:1,archived2020:1}; week2={future2099:1,done2020:1,archived2020:1}`。
- 影响：用户会把跨年份/历史事项误看成本周安排。之前修过的 Radar/Dashboard 时效策略并没有覆盖本页。
- 修复方向：周视图确定真实起止日期，事件保留 date 并按日期过滤；学期未配置时明确使用自然周还是禁用教学周，不默认把历史重复投到每一周。历史状态应明确标识或可切换查看。

## 4. [P2] 通知合并来源链在真实数据库适配层丢失

- 位置：`web/src/lib/ingest/dedupe.ts:128-135`，`web/src/lib/data/supabase.ts:100-114,288-302`。
- 根因：合并流程传入 mergedFrom，SupabaseRepository.updateInbox 未映射该字段，rowToInbox 也不恢复；目前迁移未提供对应持久化字段。
- 复现：调用 updateInbox(id,{mergedFrom:["duplicate"]})，捕获发往数据库的更新为 `{}`，返回对象 mergedFrom 为 undefined；即使 fixture 行提供 merged_from 也不返回。
- 实际输出：`requestedMergedFrom=["duplicate"]; sentPatch={}; returnedMergedFrom=null`。
- 影响：Demo 的合并引用可用，但真实数据库没有完整追溯链。重复条归档仍能写入，这并不等于归档失败；此前聚类漏合并算法修复仍有效。
- 修复方向：追加非破坏式迁移和双向字段映射，补真实库读回/重跑幂等测试，不能只改 Demo。

## 5. [P2] 登录输入完成后按 Enter 不会提交

- 位置：`web/src/app/auth.tsx:89-103,115-121`。
- 根因：输入框和按钮没有 form/onSubmit，只有按钮 onClick。
- 浏览器复现：填入 fixture 邮箱密码，密码框按 Enter 后认证请求数为 0；点击登录按钮后为 1，页面 form 数量为 0。认证请求被拦截，未登录任何真实账号。
- 修复方向：使用可访问的 form/onSubmit，保留保存中防重复提交与错误提示；补 Enter/点击一致性测试。

## 建议顺序与边界

先修账号同步作用域与核验落库假成功，再修日历真实日期归属和合并来源持久化，最后补登录表单键盘操作。

忘记密码、共享远程测试环境、浏览器聊天跨设备持久化是待补能力，不冒充本轮已复现故障。Agent 权限确认按用户决定继续暂缓；后台共享 Store/真并发等此前审查事项，本轮未做新的故障注入验证，不计入上述 5 项已复现结果。
