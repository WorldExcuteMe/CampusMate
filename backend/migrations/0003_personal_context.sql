-- CampusMate Personal Campus Context schema（提案 · 未应用）
-- 对应 docs/campusmate-2.0/05_PERSONAL_CONTEXT.md。复用 profiles/information_sources（0001）。
-- 课程规则与临时调课分表；user_id 隔离 + RLS；保留来源/导入时间/版本。
-- 回滚：drop 下列新增表（不影响 0001/0002）。

create extension if not exists pgcrypto;

-- 用户高校画像（扩展 profiles，不重复存储 interests/skills/goals，引用 profiles）
create table if not exists user_institution_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  university text not null default '',
  college text not null default '',
  academic_year text not null default '',
  semester text not null default '',
  preferences jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- 学期
create table if not exists academic_terms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  institution_id text not null default '',
  name text not null,
  start_date date not null,
  end_date date not null,
  total_weeks int not null default 20,
  timezone text not null default 'Asia/Shanghai',
  created_at timestamptz not null default now()
);
create index if not exists idx_terms_user on academic_terms(user_id);

-- 课程
create table if not exists courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  term_id uuid not null references academic_terms(id) on delete cascade,
  name text not null,
  teacher text not null default '',
  credit numeric not null default 0
);
create index if not exists idx_courses_term on courses(term_id);

-- 课程规则（每周重复）
create table if not exists course_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  term_id uuid not null references academic_terms(id) on delete cascade,
  course_id uuid references courses(id) on delete cascade,
  course_name text not null,
  weekday int not null check (weekday between 1 and 7),
  start_time text not null,
  end_time text not null,
  start_week int not null default 1,
  end_week int not null default 20,
  week_pattern text not null default 'every' check (week_pattern in ('every','odd','even')),
  classroom text not null default '',
  campus text not null default '',
  source text not null default '',
  imported_at timestamptz not null default now()
);
create index if not exists idx_schedules_term on course_schedules(term_id, weekday);

-- 临时调课/补课/停课/教室变更/节假日（独立，不覆盖正常规则）
create table if not exists schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  term_id uuid not null references academic_terms(id) on delete cascade,
  schedule_id uuid references course_schedules(id) on delete set null,
  kind text not null check (kind in ('reschedule','makeup','cancel','room_change','holiday')),
  date date not null,
  weekday int,
  start_time text,
  end_time text,
  classroom text not null default '',
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_exceptions_term_date on schedule_exceptions(term_id, date);

-- 导入任务（预览/确认/版本）
create table if not exists import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  term_id uuid references academic_terms(id) on delete cascade,
  format text not null,
  status text not null default 'pending' check (status in ('pending','previewed','confirmed','failed')),
  source_name text not null default '',
  preview_count int not null default 0,
  error_count int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists idx_import_jobs_user on import_jobs(user_id);

-- ===== RLS（owner 隔离）=====
alter table user_institution_profiles enable row level security;
alter table academic_terms enable row level security;
alter table courses enable row level security;
alter table course_schedules enable row level security;
alter table schedule_exceptions enable row level security;
alter table import_jobs enable row level security;

create policy uip_owner on user_institution_profiles for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy terms_owner on academic_terms for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy courses_owner on courses for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy schedules_owner on course_schedules for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy exceptions_owner on schedule_exceptions for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy import_jobs_owner on import_jobs for all using (auth.uid()=user_id) with check (auth.uid()=user_id);

-- 回滚脚本（如需）：
-- drop table if exists schedule_exceptions, course_schedules, courses, import_jobs, academic_terms, user_institution_profiles cascade;