-- Additive display sync stamps. Use 64-bit transaction IDs, NOT timestamps or
-- a sequence high-water mark (a later transaction can commit before an older one).
alter table public.agent_tasks add column history_xid bigint not null default 0;
alter table public.agent_session_messages add column history_xid bigint not null default 0;
alter table public.agent_sessions add column legacy_xid bigint not null default 0;
create function public.campusmate_stamp_history() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  new.history_xid := txid_current();
  return new;
end $$;
create trigger campusmate_task_history before insert or update on public.agent_tasks for each row execute function public.campusmate_stamp_history();
create trigger campusmate_message_history before insert or update on public.agent_session_messages for each row execute function public.campusmate_stamp_history();
create function public.campusmate_stamp_legacy() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if new.legacy_history is distinct from old.legacy_history then new.legacy_xid := txid_current(); end if;
  return new;
end $$;
create trigger campusmate_legacy_history before update of legacy_history on public.agent_sessions for each row execute function public.campusmate_stamp_legacy();
revoke all on function public.campusmate_stamp_history() from public;
revoke all on function public.campusmate_stamp_legacy() from public;
create index agent_tasks_session_history_delta on public.agent_tasks(user_id,session_id,history_xid);
create index agent_tasks_session_history_page on public.agent_tasks(user_id,session_id,created_at desc,id desc);
create index agent_messages_session_history_delta on public.agent_session_messages(user_id,session_id,history_xid) where task_id is null and role in ('user','assistant');
-- Existing history stays at stamp 0 and is reachable through keyset pages.
-- No data rewrite/reset, no relaxation of existing RLS, no extra parent-row locks.
