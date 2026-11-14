-- Additive, private calendar metadata. Legacy exceptions without source_date remain explicit warnings.
alter table academic_terms add column if not exists week_anchor date;
alter table schedule_exceptions add column if not exists source_date date;
alter table import_jobs add column if not exists preview jsonb;
alter table import_jobs add column if not exists saved_schedule_ids uuid[] not null default '{}';

create table if not exists timetable_schemes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  term_id uuid not null references academic_terms(id) on delete cascade,
  institution_id text not null,
  campus text not null default '',
  name text not null,
  effective_from date not null,
  effective_to date not null,
  periods jsonb not null,
  created_at timestamptz not null default now(),
  check (effective_to >= effective_from),
  check (jsonb_typeof(periods) = 'array')
);
create index if not exists idx_timetable_schemes_owner_term on timetable_schemes(user_id, term_id, effective_from);
alter table timetable_schemes enable row level security;
create policy timetable_schemes_owner on timetable_schemes for all using (auth.uid() = user_id) with check (auth.uid() = user_id and exists (select 1 from academic_terms t where t.id=term_id and t.user_id=auth.uid()));
