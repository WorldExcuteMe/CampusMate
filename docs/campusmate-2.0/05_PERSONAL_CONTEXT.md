# 05 · Personal Campus Context（Stage 4）

> 基于真实代码。结构化业务数据独立建模，不塞进 Memory。

## 数据模型（core/personal-context.ts）

| 类型 | 字段要点 |
|---|---|
| InstitutionProfile | university/college/major/grade/academicYear/semester/interests/skills/goals/preferences |
| AcademicTerm | startDate/endDate/totalWeeks/timezone |
| Course | name/teacher/credit |
| CourseSchedule | weekday/startTime/endTime/startWeek/endWeek/weekPattern(every/odd/even)/classroom/campus/source/importedAt |
| ScheduleException | kind(reschedule/makeup/cancel/room_change/holiday)/date/独立于正常规则 |
| InformationSource | kind(academic_system/campus_website/student_group/official_account)/url/adapterId/enabled |
| ImportJob | format/status(pending/previewed/confirmed/failed)/previewCount/errorCount/version |

- **课程规则与临时调课分表**：CourseSchedule（每周重复）vs ScheduleException（具体日期），调课不覆盖正常规则。
- **user_id 隔离**：PersonalContextStore 所有方法按 userId 过滤；跨用户不可见（测试验证）。
- 复用 0001 的 profiles/information_sources；新增表见 migration 0003。

## 教学周/单双周

- `currentTeachingWeek(term, now)`：学期起始→当前教学周（开学前=0，封顶 totalWeeks）。
- `occursInWeek(schedule, week)`：周次范围 + 单双周判定。

## Migration 0003（提案，未应用）

`backend/migrations/0003_personal_context.sql`：user_institution_profiles/academic_terms/courses/course_schedules/schedule_exceptions/import_jobs + RLS owner 策略 + 回滚脚本。
**BLOCKED_EXTERNAL**：生产 Supabase 网络封锁，未应用；DDL 待 dashboard/直连应用。

## Store

InMemoryPersonalContextStore（开发/测试）；Postgres 实现待 migration 应用后接入（接口已定义）。

## 测试

personal-context.test.ts：CSV/XLSX/ICS 解析、教学周/单双周、去重、冲突、user 隔离、调课独立、增删、导入版本/确认。