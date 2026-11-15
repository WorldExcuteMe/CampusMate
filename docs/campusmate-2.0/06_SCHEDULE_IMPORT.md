# 06 · Schedule Import（Stage 4）

> 基于真实代码 core/schedule-import.ts。第一阶段 ICS/CSV/XLSX。

## 解析器

| 格式 | 函数 | 说明 |
|---|---|---|
| CSV | parseCsv | 列 courseName/weekday/startTime/endTime/startWeek/endWeek/weekPattern/classroom/campus；逐行错误部分恢复 |
| XLSX | parseXlsx | SheetJS（xlsx 0.18.5）读首表，sheet_to_json 标准化 |
| ICS | parseIcs | VEVENT SUMMARY/DTSTART/DTEND/RRULE(BYDAY,COUNT)/LOCATION→周次/星期 |

## 标准化 + 校验（normalizeRow）

- 课程名非空；weekday 1-7；时间 HH:MM 且结束>开始；周次范围 startWeek≥1 且 endWeek≥startWeek；weekPattern ∈ every/odd/even。
- 错误行报错但不整体失败（部分恢复）。

## 去重 + 冲突

- `dedupSchedules`：同课程名+星期+时间+周次+单双周 → 去重。
- `detectConflicts`：同星期、周次重叠、单双周相容、时间段重叠 → 冲突对。

## 导入流程

`previewImport(format, data, termStart, totalWeeks)` → {schedules, errors, duplicates, conflicts}（预览不保存）→ 用户确认 → PersonalContextStore.saveSchedules + ImportJob status confirmed（版本管理）。

## 调课/补课/停课/教室变更

`makeException(kind, date, opts)` → 独立 ScheduleException，关联 scheduleId 但**不覆盖正常规则**（测试验证：加调课后正常课程数不变）。

## 测试证据（AC09/AC10/AC11）

- AC09 ICS/CSV/XLSX 导入：**VERIFIED**（三格式 fixture 解析通过）。
- AC10 教学周/单双周：**VERIFIED**（currentTeachingWeek/occursInWeek 测试）。
- AC11 临时调课：**VERIFIED**（ScheduleException 独立，不覆盖规则）。
- 后端 149 测试（148 过/1 skip），tsc 0。

## 后续（第二阶段）
- PDF/HTML/图片 OCR 解析（Stage 5 Institution Adapter）。
- Postgres 持久化（migration 0003 应用后）。
- 真实高校课表样本（三开发者脱敏提供）→ 回归 fixture。