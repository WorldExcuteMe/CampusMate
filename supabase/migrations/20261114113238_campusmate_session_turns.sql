-- Spec v2 / T2: atomic accepted turns, ordered execution and durable inputs.
alter table agent_sessions add column next_turn_seq integer not null default 1 check (next_turn_seq > 0);
alter table agent_tasks add column turn_id text;
alter table agent_tasks add column turn_seq integer;
alter table agent_tasks add column input_hash text;
alter table agent_tasks add column transcript_committed boolean not null default false;
alter table agent_tasks add column images jsonb;
alter table agent_tasks add column prompt_usage jsonb;
alter table agent_tasks add constraint agent_tasks_turn_shape check (
  (turn_id is null and turn_seq is null and input_hash is null) or
  (session_id is not null and turn_id is not null and turn_seq > 0 and input_hash is not null)
);
alter table agent_tasks add constraint agent_tasks_unique_turn unique(user_id,session_id,turn_id);
alter table agent_tasks add constraint agent_tasks_unique_turn_seq unique(user_id,session_id,turn_seq);
alter table agent_tasks add constraint agent_tasks_session_turn_fk foreign key(user_id,session_id,turn_id)
  references agent_session_turns(user_id,session_id,turn_id);
create index agent_tasks_session_order on agent_tasks(user_id,session_id,turn_seq);
