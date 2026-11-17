-- Additive session metadata/tombstones; never delete task or message history.
alter table public.agent_sessions
  add column archived boolean not null default false,
  add column deleted_at timestamptz,
  add column revision integer not null default 0 check (revision >= 0),
  add column legacy_history jsonb not null default '[]'::jsonb,
  add column legacy_hash text;
-- legacy_history is display-only. Worker history never reads this column.
