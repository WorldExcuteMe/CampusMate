-- Apply AFTER 0001_init.sql. Existing production data is preserved.
begin;

alter table public.inbox_items
  add column if not exists extraction_mock boolean not null default true;
alter table public.agent_runs
  add column if not exists provider text not null default 'unknown',
  add column if not exists is_mock boolean not null default false;

-- Old browser extraction was always Mock; preserve truthful provenance.
update public.agent_runs set provider = 'mock', is_mock = true
where model = 'rule-based-mock' and provider = 'unknown';

create or replace function public.initialize_campusmate_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.initialize_campusmate_profile() from public, anon, authenticated;
drop trigger if exists campusmate_profile_on_signup on auth.users;
create trigger campusmate_profile_on_signup
  after insert on auth.users
  for each row execute function public.initialize_campusmate_profile();

insert into public.profiles (id) select id from auth.users on conflict (id) do nothing;
commit;
