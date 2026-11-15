-- CampusMate Agent 运行时 schema（提案 · 未应用）
-- 对应 docs/agent-core/DATABASE_SCHEMA_SPEC.md。本阶段禁止改库；经团队确认后经 supabase migration 应用。
-- 原则：结构化状态=事实来源；agent_events=追踪（append-only）；agent_checkpoints=恢复。
-- 全部 agent_ 前缀，绝不与用户待办 tasks 表混淆。

create extension if not exists pgcrypto;

-- 目标（区别于业务 goals）
create table if not exists agent_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_text text not null,
  normalized jsonb not null default '{}',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

-- 任务（队列 + 事实来源）
create table if not exists agent_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid references agent_goals(id) on delete set null,
  session_id uuid,
  title text not null,
  intent text not null default '',
  status text not null default 'queued',
  priority int not null default 50,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt int not null default 0,
  max_attempts int not null default 3,
  budget jsonb not null default '{"tokens":200000,"toolCalls":40,"wallMs":600000,"costUsd":0.5}',
  usage jsonb not null default '{"tokens":0,"toolCalls":0,"wallMs":0,"costUsd":0}',
  last_checkpoint_id uuid,
  cancel_requested boolean not null default false,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_agent_tasks_claim on agent_tasks(status, priority, created_at);
create index if not exists idx_agent_tasks_lease on agent_tasks(status, lease_expires_at);
create index if not exists idx_agent_tasks_user on agent_tasks(user_id, created_at);

-- 步骤（DAG + 验收）
create table if not exists agent_steps (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seq int not null,
  kind text not null default 'act',
  title text not null,
  depends_on uuid[] not null default '{}',
  acceptance jsonb not null default '{}',
  status text not null default 'pending',
  attempt int not null default 0,
  output_ref uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(task_id, seq)
);
create index if not exists idx_agent_steps_task on agent_steps(task_id, status);

-- 事件日志（append-only）
create table if not exists agent_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  step_id uuid references agent_steps(id) on delete set null,
  seq int not null,
  type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(task_id, seq)
);
create index if not exists idx_agent_events_task on agent_events(task_id, seq);

-- 检查点（恢复）
create table if not exists agent_checkpoints (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  step_id uuid references agent_steps(id) on delete set null,
  event_seq int not null,
  state jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_checkpoints_task on agent_checkpoints(task_id, created_at);

-- 工具调用（幂等 + 执行记录）
create table if not exists agent_tool_invocations (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  step_id uuid references agent_steps(id) on delete set null,
  tool_name text not null,
  idempotency_key text not null,
  args_hash text not null,
  runtime text not null default 'cloud',
  status text not null default 'pending',
  approval_id uuid,
  result jsonb,
  error text,
  attempt int not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(task_id, idempotency_key)
);
create index if not exists idx_agent_tool_inv_task on agent_tool_invocations(task_id);

-- 产物 / 证据
create table if not exists agent_artifacts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  storage_path text,
  inline jsonb,
  sha256 text,
  created_at timestamptz not null default now()
);
create table if not exists agent_evidence (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_url text not null,
  excerpt text not null default '',
  retrieved_at timestamptz not null default now(),
  supports text not null default '',
  confidence numeric not null default 0.5,
  artifact_id uuid references agent_artifacts(id) on delete set null,
  verified boolean not null default false
);

-- ===== RLS =====
alter table agent_goals enable row level security;
alter table agent_tasks enable row level security;
alter table agent_steps enable row level security;
alter table agent_events enable row level security;
alter table agent_checkpoints enable row level security;
alter table agent_tool_invocations enable row level security;
alter table agent_artifacts enable row level security;
alter table agent_evidence enable row level security;

-- 客户端 owner 只读；写由服务端 service_role（绕过 RLS，代码层强制 user_id 隔离）
create policy agent_goals_owner_read on agent_goals for select using (auth.uid()=user_id);
create policy agent_tasks_owner_read on agent_tasks for select using (auth.uid()=user_id);
create policy agent_steps_owner_read on agent_steps for select using (auth.uid()=user_id);
create policy agent_events_owner_read on agent_events for select using (auth.uid()=user_id);
create policy agent_checkpoints_owner_read on agent_checkpoints for select using (auth.uid()=user_id);
create policy agent_tool_inv_owner_read on agent_tool_invocations for select using (auth.uid()=user_id);
create policy agent_artifacts_owner_read on agent_artifacts for select using (auth.uid()=user_id);
create policy agent_evidence_owner_read on agent_evidence for select using (auth.uid()=user_id);

-- 客户端可提交自己的 queued 任务；不可改状态/lease（防伪造进度）。取消经 RPC 封装。
create policy agent_tasks_owner_insert on agent_tasks for insert with check (auth.uid()=user_id and status='queued');

-- 事件日志 append-only：无 update/delete 策略。service_role 代码层只 insert。

-- ===== 现有表最小增量（幂等/审计/核验门控）=====
alter table inbox_items add column if not exists dedup_key text;
create unique index if not exists uq_inbox_user_dedup on inbox_items(user_id, dedup_key) where dedup_key is not null;
alter table inbox_items add column if not exists merged_from uuid[] not null default '{}';

alter table opportunities add column if not exists created_by uuid references auth.users(id);
alter table opportunities add column if not exists content_hash text;
create unique index if not exists uq_opp_content on opportunities(content_hash) where content_hash is not null;

alter table verification_reports add column if not exists task_id uuid references agent_tasks(id);
alter table verification_reports add column if not exists evaluated_by text not null default 'pending';
alter table verification_reports add column if not exists evidence_count int not null default 0;

-- VERIFIED 门控：仅 evaluated_by='evaluator' 且 evidence_count>=1 才允许（应用层 + 触发器双重）。
create or replace function enforce_verified_gate() returns trigger as $$
begin
  if new.status = 'VERIFIED' and (new.evaluated_by <> 'evaluator' or new.evidence_count < 1) then
    raise exception 'VERIFIED requires evaluator approval and >=1 evidence';
  end if;
  return new;
end;
$$ language plpgsql;
drop trigger if exists trg_verified_gate on verification_reports;
create trigger trg_verified_gate before insert or update on verification_reports
  for each row execute function enforce_verified_gate();