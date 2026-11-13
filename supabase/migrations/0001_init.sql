-- CampusMate 初始 schema · Supabase PostgreSQL 唯一业务库
-- 见 docs/DATABASE_DESIGN.md。MVP 将 interests/skills/goals 以数组存于 profiles；
-- profile_skills/profile_interests 为后续规范化候选，暂不启用。

create extension if not exists pgcrypto;

-- 用户画像
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  major text not null default '',
  grade text not null default '',
  interests text[] not null default '{}',
  skills text[] not null default '{}',
  goals text[] not null default '{}',
  time_budget_hours int not null default 10,
  bio text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists user_preferences (
  profile_id uuid primary key references profiles(id) on delete cascade,
  match_weights jsonb not null default '{"interest":25,"skill":25,"goal":20,"time":15,"experience":15}'
);

-- 官方信息来源白名单
create table if not exists information_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null unique,
  source_type text not null default 'official',
  is_official boolean not null default true,
  whitelist_status text not null default 'approved',
  created_at timestamptz not null default now()
);

-- 收件箱
create table if not exists inbox_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_text text not null,
  source_url text,
  source_type text not null default 'text',
  extracted jsonb not null,
  classification jsonb not null,
  status text not null default 'pending_review',
  storage_path text,
  created_at timestamptz not null default now()
);
create index if not exists idx_inbox_user_status on inbox_items(user_id, status);

-- 机会
create table if not exists opportunities (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  type text not null,
  organizer text not null default '',
  description text not null default '',
  conditions text[] not null default '{}',
  deadline date,
  source_url text not null,
  source_type text not null default 'official',
  collected_at timestamptz not null default now(),
  status text not null default 'active',
  is_demo boolean not null default false
);
create index if not exists idx_opp_type_status on opportunities(type, status);
create index if not exists idx_opp_deadline on opportunities(deadline);

create table if not exists opportunity_sources (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  source_id uuid references information_sources(id) on delete set null,
  url text not null,
  retrieved_at timestamptz not null default now()
);
create index if not exists idx_oppsrc_opp on opportunity_sources(opportunity_id);

-- 匹配评估
create table if not exists match_assessments (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  score numeric not null default 0,
  breakdown jsonb not null default '{}',
  reasons jsonb not null default '[]',
  hard_filter_passed boolean not null default true,
  created_at timestamptz not null default now(),
  unique(opportunity_id, user_id)
);

-- 核验报告与证据
create table if not exists verification_reports (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  status text not null default 'UNVERIFIED',
  summary text not null default '',
  findings jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index if not exists idx_report_opp on verification_reports(opportunity_id);

create table if not exists evidence_items (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references verification_reports(id) on delete cascade,
  source_url text not null,
  source_type text not null default 'official',
  excerpt text not null default '',
  retrieved_at timestamptz not null default now(),
  supports text not null default '',
  confidence numeric not null default 0.5
);
create index if not exists idx_evidence_report on evidence_items(report_id);

-- 目标 / 计划 / 任务
create table if not exists goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null default 'personal',
  title text not null,
  target_date date,
  status text not null default 'active',
  created_at timestamptz not null default now()
);
create index if not exists idx_goals_user on goals(user_id, status);

create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid references goals(id) on delete cascade,
  opportunity_id uuid references opportunities(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  phases jsonb not null default '[]',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid references plans(id) on delete set null,
  inbox_item_id uuid references inbox_items(id) on delete set null,
  title text not null,
  due_at date,
  estimate_hours numeric,
  depends_on uuid[] not null default '{}',
  status text not null default 'todo',
  priority int not null default 50,
  kind text not null default 'general',
  time_text text,
  created_at timestamptz not null default now()
);
create index if not exists idx_tasks_user_status on tasks(user_id, status);
create index if not exists idx_tasks_due on tasks(due_at);

-- 审计
create table if not exists activity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_activity_user on activity_events(user_id, created_at);

create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_type text not null,
  status text not null default 'running',
  input_ref text,
  output_ref text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error text,
  model text,
  token_usage jsonb not null default '{}'
);
create index if not exists idx_runs_user on agent_runs(user_id, started_at);

-- ===== RLS =====
alter table profiles enable row level security;
alter table user_preferences enable row level security;
alter table inbox_items enable row level security;
alter table match_assessments enable row level security;
alter table goals enable row level security;
alter table plans enable row level security;
alter table tasks enable row level security;
alter table activity_events enable row level security;
alter table agent_runs enable row level security;
alter table information_sources enable row level security;
alter table opportunities enable row level security;
alter table opportunity_sources enable row level security;
alter table verification_reports enable row level security;
alter table evidence_items enable row level security;

-- owner 策略
create policy profiles_owner on profiles for all using (auth.uid() = id) with check (auth.uid() = id);
create policy prefs_owner on user_preferences for all using (auth.uid() = profile_id) with check (auth.uid() = profile_id);
create policy inbox_owner on inbox_items for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy match_owner on match_assessments for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy goals_owner on goals for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy plans_owner on plans for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy tasks_owner on tasks for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy activity_owner on activity_events for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy runs_owner on agent_runs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 公共参考数据：公开读，写仅服务端（service_role 绕过 RLS）
create policy sources_read on information_sources for select using (true);
create policy opp_read on opportunities for select using (true);
create policy oppsrc_read on opportunity_sources for select using (true);
create policy report_read on verification_reports for select using (true);
create policy evidence_read on evidence_items for select using (true);