# CampusMate · DATABASE_DESIGN.md

版本 0.1 · 2026-11-12 · Supabase PostgreSQL 唯一业务库 · 先 ERD 后 Migration

## 1. 原则

- 所有变更经 `supabase/migrations/` 管理；不建第二套数据库。
- 主键统一 `uuid default gen_random_uuid()`；用户数据外键到 `auth.users`。
- 半结构化内容用 JSONB（extracted、breakdown、phases），**不把所有数据塞一个 JSON 字段**。
- 每表分析：主键/外键/索引/约束/生命周期/RLS。
- 用户删除数据 cascade + Storage 文件清理 + 隐私保护。

## 2. ERD（关系概览）

```
auth.users 1─1 profiles 1─N profile_skills / profile_interests / user_preferences
profiles 1─N inbox_items / goals / plans / tasks / activity_events / agent_runs
information_sources 1─N opportunities（经 opportunity_sources N─N）
inbox_items 1─N tasks（可选关联）
opportunities 1─N match_assessments / verification_reports
verification_reports 1─N evidence_items
goals 1─N plans 1─N tasks
opportunities 1─N plans（可选）
```

## 3. 表设计（16 表）

| 表 | 关键字段 | 索引/约束 | RLS |
|---|---|---|---|
| profiles | id PK=auth.uid, major, grade, time_budget_hours, bio | PK | owner select/insert/update |
| profile_skills | id, profile_id FK, skill, level | (profile_id) | owner |
| profile_interests | id, profile_id FK, interest | (profile_id) | owner |
| user_preferences | profile_id PK FK, match_weights jsonb | PK | owner |
| information_sources | id, name, url, source_type, is_official, whitelist_status | (url) unique | public read（白名单）；写仅服务 |
| inbox_items | id, user_id FK, raw_text, source_url, source_type, extracted jsonb, category, class, priority_score, status, confidence, storage_path | (user_id,status), (deadline) | owner all |
| opportunities | id, title, type, organizer, description, conditions, deadline, source_url, source_type, collected_at, status, is_demo | (type,status), (deadline) | public read（含 demo）；写仅服务 |
| opportunity_sources | id, opportunity_id FK, source_id FK, url, retrieved_at | (opportunity_id) | public read |
| match_assessments | id, opportunity_id FK, user_id FK, score, breakdown jsonb, reasons jsonb, hard_filter_passed | (user_id,opportunity_id) unique | owner |
| verification_reports | id, opportunity_id FK, status, summary, created_at | (opportunity_id) | public read |
| evidence_items | id, report_id FK, source_url, source_type, excerpt, retrieved_at, supports, confidence | (report_id) | public read |
| goals | id, user_id FK, type, title, target_date, status | (user_id,status) | owner |
| plans | id, goal_id FK, opportunity_id FK null, user_id FK, phases jsonb, status | (user_id) | owner |
| tasks | id, user_id FK, plan_id FK null, inbox_item_id FK null, title, due_at, estimate_hours, depends_on uuid[], status, priority | (user_id,status), (due_at) | owner |
| activity_events | id, user_id FK, event_type, entity_type, entity_id, payload jsonb, created_at | (user_id,created_at) | owner |
| agent_runs | id, user_id FK, task_type, status, input_ref, output_ref, started_at, completed_at, error, model, token_usage jsonb | (user_id,started_at) | owner |

## 4. 生命周期与隐私

- inbox_items/tasks/goals/plans：用户删除 cascade；上传文件存 Storage `uploads/{uid}/`，删记录时清文件。
- opportunities/evidence/reports：公共参考数据，过期标 expired 不物理删（保留证据）。
- agent_runs/activity_events：保留审计；提供用户数据导出与删除入口（Settings）。
- Demo 数据：`is_demo=true` 公共读，与真实用户数据（RLS owner）物理隔离；Demo 模式不写真实表。

## 5. Migration 计划

`0001_init.sql`：扩展 pgcrypto、16 表、索引、外键、RLS 策略、白名单与 demo 种子（seed 单独 `seed.sql`，仅 demo/参考数据）。
后续变更一律新增编号 migration，不改历史文件。