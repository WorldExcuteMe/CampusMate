-- Non-destructive provenance for server-side inbox merging. Existing owner RLS unchanged.
alter table public.inbox_items add column if not exists merged_from uuid[] not null default '{}';
