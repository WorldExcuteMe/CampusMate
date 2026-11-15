-- CampusMate Spec v2 / T1. Generated with Supabase CLI 3.1.0; local file only.
-- Requires 0001_init, 0002_agent_runtime, 0003_personal_context in that order.
-- Additive schema; no production application is authorized by this file.
-- Rollback compatibility: old callers may remain, but keep visibility enforcement
-- once private opportunities exist. Never restore a universal public-read policy.

alter table agent_tasks add constraint agent_tasks_user_id_id_key unique (user_id, id);
alter table academic_terms add constraint academic_terms_user_id_id_key unique (user_id, id);
alter table courses add constraint courses_user_id_id_key unique (user_id, id);
alter table course_schedules add constraint course_schedules_user_id_id_key unique (user_id, id);

-- Parent ownership is a database invariant as well as a repository check.
alter table courses add constraint courses_owner_term_fk
  foreign key (user_id, term_id) references academic_terms(user_id, id) on delete cascade;
alter table course_schedules add constraint schedules_owner_term_fk
  foreign key (user_id, term_id) references academic_terms(user_id, id) on delete cascade;
alter table course_schedules add constraint schedules_owner_course_fk
  foreign key (user_id, course_id) references courses(user_id, id);
alter table schedule_exceptions add constraint exceptions_owner_term_fk
  foreign key (user_id, term_id) references academic_terms(user_id, id) on delete cascade;
alter table schedule_exceptions add constraint exceptions_owner_schedule_fk
  foreign key (user_id, schedule_id) references course_schedules(user_id, id);
alter table import_jobs add constraint import_jobs_owner_term_fk
  foreign key (user_id, term_id) references academic_terms(user_id, id) on delete cascade;

create table agent_approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  tool_name text not null,
  args jsonb not null default '{}',
  idempotency_key text not null,
  risk text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (task_id, idempotency_key),
  foreign key (user_id, task_id) references agent_tasks(user_id, id) on delete cascade
);
create index agent_approvals_owner_pending on agent_approvals(user_id, status, created_at);

create table agent_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '新会话',
  mode text not null default 'auto' check (mode in ('auto','daily')),
  summary text not null default '',
  summary_through_seq integer not null default 0 check (summary_through_seq >= 0),
  next_seq integer not null default 1 check (next_seq > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);
create index agent_sessions_owner_updated on agent_sessions(user_id, updated_at desc);

create table agent_session_turns (
  user_id uuid not null,
  session_id uuid not null,
  turn_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, session_id, turn_id),
  foreign key (user_id, session_id) references agent_sessions(user_id, id) on delete cascade
);

create table agent_session_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  session_id uuid not null,
  turn_id text not null,
  message_key text not null,
  task_id uuid,
  seq integer not null check (seq > 0),
  role text not null check (role in ('system','user','assistant','tool')),
  -- Full ChatMessage envelope, including tool_calls/tool_call_id and image parts.
  content jsonb not null,
  created_at timestamptz not null default now(),
  unique (session_id, seq),
  unique (user_id, session_id, message_key),
  foreign key (user_id, session_id, turn_id)
    references agent_session_turns(user_id, session_id, turn_id) on delete cascade,
  foreign key (user_id, task_id) references agent_tasks(user_id, id) on delete cascade
);
create index agent_session_messages_turn on agent_session_messages(session_id, turn_id, seq);
create index agent_session_messages_task on agent_session_messages(task_id);

-- Write-only encrypted credential envelopes: no client read policy on this table.
create table user_llm_providers (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_id text not null check (length(provider_id) between 1 and 128),
  display_name text not null,
  protocol text not null,
  base_url text not null,
  model_id text not null,
  capabilities jsonb not null default '{}',
  context_limit integer check (context_limit > 0),
  metadata_source text not null default 'configured',
  encrypted_secret jsonb,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider_id),
  constraint user_llm_providers_ciphertext_shape check (
    encrypted_secret is null or (
      jsonb_typeof(encrypted_secret) = 'object'
      and encrypted_secret ?& array['algorithm','keyVersion','nonce','tag','ciphertext']
      and encrypted_secret->>'algorithm' = 'AES-256-GCM'
      and jsonb_typeof(encrypted_secret->'keyVersion') = 'string'
      and jsonb_typeof(encrypted_secret->'nonce') = 'string'
      and jsonb_typeof(encrypted_secret->'tag') = 'string'
      and jsonb_typeof(encrypted_secret->'ciphertext') = 'string'
    )
  )
);
create unique index user_llm_providers_one_default on user_llm_providers(user_id) where is_default;

-- Existing public catalog rows stay public. New Agent rows explicitly use private.
alter table opportunities add column visibility text not null default 'public'
  check (visibility in ('public','private'));
alter table opportunities add constraint opportunities_private_owner
  check (visibility = 'public' or created_by is not null);
create index opportunities_owner_visibility on opportunities(created_by, visibility);
drop policy if exists opp_read on opportunities;
create policy opp_read on opportunities for select
  using (visibility = 'public' or created_by = auth.uid());

-- Parent RLS does not automatically protect rows in related tables.
drop policy if exists oppsrc_read on opportunity_sources;
create policy oppsrc_read on opportunity_sources for select using (exists (
  select 1 from opportunities o where o.id = opportunity_id
    and (o.visibility = 'public' or o.created_by = auth.uid())
));
drop policy if exists report_read on verification_reports;
create policy report_read on verification_reports for select using (exists (
  select 1 from opportunities o where o.id = opportunity_id
    and (o.visibility = 'public' or o.created_by = auth.uid())
));
drop policy if exists evidence_read on evidence_items;
create policy evidence_read on evidence_items for select using (exists (
  select 1 from verification_reports r join opportunities o on o.id = r.opportunity_id
  where r.id = report_id and (o.visibility = 'public' or o.created_by = auth.uid())
));

create table user_opportunities (
  user_id uuid not null references auth.users(id) on delete cascade,
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  status text not null default 'active' check (status in ('active','expired','archived')),
  created_at timestamptz not null default now(),
  primary key (user_id, opportunity_id)
);
create index user_opportunities_owner_created on user_opportunities(user_id, created_at desc);

create table user_information_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid references information_sources(id) on delete set null,
  name text not null,
  kind text not null,
  url text,
  adapter_id text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index user_information_sources_owner on user_information_sources(user_id, created_at);

alter table agent_artifacts add column document_id uuid not null default gen_random_uuid();
alter table agent_artifacts add column revision integer not null default 1 check (revision > 0);
alter table agent_artifacts add constraint agent_artifacts_document_revision_key
  unique (task_id, document_id, revision);
alter table agent_artifacts add constraint agent_artifacts_owner_task_id_key
  unique (user_id, task_id, id);
alter table agent_artifacts add constraint artifacts_owner_task_fk
  foreign key (user_id, task_id) references agent_tasks(user_id, id) on delete cascade;
alter table agent_evidence add constraint evidence_owner_task_fk
  foreign key (user_id, task_id) references agent_tasks(user_id, id) on delete cascade;
alter table agent_evidence add constraint evidence_owner_artifact_fk
  foreign key (user_id, task_id, artifact_id) references agent_artifacts(user_id, task_id, id);
create index agent_artifacts_owner_task_revision on agent_artifacts(user_id, task_id, revision);

alter table agent_approvals enable row level security;
alter table agent_sessions enable row level security;
alter table agent_session_turns enable row level security;
alter table agent_session_messages enable row level security;
alter table user_llm_providers enable row level security;
alter table user_opportunities enable row level security;
alter table user_information_sources enable row level security;

create policy agent_approvals_owner_read on agent_approvals for select using (auth.uid() = user_id);
create policy agent_sessions_owner_read on agent_sessions for select using (auth.uid() = user_id);
create policy agent_session_turns_owner_read on agent_session_turns for select using (auth.uid() = user_id);
create policy agent_session_messages_owner_read on agent_session_messages for select using (auth.uid() = user_id);
create policy user_information_sources_owner_read on user_information_sources for select using (auth.uid() = user_id);
create policy user_opportunities_owner_read on user_opportunities for select using (
  auth.uid() = user_id and exists (
    select 1 from opportunities o where o.id = opportunity_id
      and (o.visibility = 'public' or o.created_by = auth.uid())
  )
);
-- No user_llm_providers policy: authenticated clients only receive safe API DTOs.
-- All server repositories still verify authenticated owner and parent ownership.
