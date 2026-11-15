# T5 具体日期、课表确认与作息

Status: accepted（本地功能），2026-11-15，主代理单独执行。沿用已批准R4、AC09/10/19。基线14c3b19；备份v8。

- 所有课程按学期timezone、第一教学周周一锚点投影到YYYY-MM-DD；开始日期允许周中，锚点可在创建学期时校正。截止日期只出现在真实日期，完成/取消/归档过滤，逾期分列。
- shared/calendar.ts提供前后端共用纯日期和例外逻辑。reschedule新增sourceDate，date保留为目标；旧无sourceDate记录仅当作额外课并提示语义不全，不猜测删哪一天。停课/节假日/教室变更、跨周补课、单双周统一投影。
- 作息方案按owner/institution/campus/term/effectiveFrom/To保存，periods是节次到真实起止时间的辅助映射。课表仍存真实HH:MM；没有模板时使用真实时钟，不硬套某学校节次。
- 导入保存不可变预览job（CSV/ICS/XLSX，错误/重复/冲突）；确认按owner读取job并事务内追加去重，不信客户端重新提交的正文。确认幂等，既有课表不覆盖。XLSX明确base64传输，ICS按TZID/UTC转学期时区，不支持的复杂规则明确报错。
- Calendar四态、日/周切换、日期导航、稳定课程颜色及时间轴；移动默认日，周视图允许内部横滚，重叠课程并列提示冲突。非本周规则不计占用；仅今天显示当前时间线。
- Today复用同一投影/选择器，显示今日课程、下一项、待办和七天截止；课表未接入/空/失败不输出全天可用。页面查询用统一key，确认后失效刷新。

影响面：shared/calendar.ts；backend个人上下文/ImportJob、Store及增量迁移、API、schedule-import；web calendar-grid/today/api-client、Calendar导入/TimeTable/useCampusCalendar、Dashboard。改变的公开接口均为增量；旧导入confirm请求现在需先获得预览jobId，不保留无预览直接保存的捷径。

GWT：跨周截止只显示一次；学校时区跨午夜/单双周/源目标调课正确；未知课表没有空闲建议；CSV引用字段和非法时间正确处理；ICS时区/COUNT/INTERVAL与不支持规则明确处理；XLSX API可真实解码；预览不写课程、确认只追加一次、他人job拒绝；不同学校作息生效/节次映射准确；Calendar确认后与Today共享查询刷新。

验证顺序：先正确消费者红灯→最小实现→定向/两侧类型→完整后端/迁移→完整前端/构建。多尺寸实际浏览器验收在T7/T8，无远程DB或付费模型操作。

官方核验（2026-11-15）：https://www.rfc-editor.org/rfc/rfc5545 —— ICS的UTC/本地TZID、周循环COUNT/UNTIL/BYDAY具有明确语义；本实现按分钟接收周循环，EXDATE/RDATE/RECURRENCE-ID及其他复杂规则明确报错，不猜测展开。自定义TZID须可被Intl识别；跨午夜课程须拆分。该受限支持范围也在导入界面说明。

## 本地结果

- 原CalendarPage行为两项与API/ICS两项先红；日期投影和预览确认接通后转绿。
- 后端完整244/244及最终定向15/15；前端完整122/122及最终日期5/5；两侧类型、生产构建、七版本迁移16/16通过。完整日志在仓库外campusmate-evidence/t5-*.log。
- memory与PGlite契约验证确认并发幂等、不同app context重读、owner隔离、源日期和作息持久化。不是独立进程PG或真实高校验收。
- Calendar用户行为验证实际跨周过滤/失败状态；导入组件验证预览不确认、显式保存job并失效共享查询；Dashboard验证真实课程/下一项及逾期不计未来七天。
- 课程颜色按课程稳定分配，重叠块并列标冲突；移动默认日、周视图内部滚动，节次只辅助真实时间。不显示非本周灰色参考层。跨校区筛选仅影响展示，空闲扣除所有校区已知课程。
- 交互预览/多尺寸/明暗主题在T7/T8继续；新增迁移没有应用远程环境。需随backend保留shared模块，Vite开发访问范围已限定仓库根。
