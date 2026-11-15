-- Owner-scoped provider configuration snapshots contain no credentials.
alter table agent_tasks add column model_config jsonb;
alter table agent_tasks add column model_runtime jsonb;
