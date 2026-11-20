-- 长任务热路径索引：事件续传、消息排序、会话/任务/审批/产物按 owner 查询。
CREATE INDEX campusmate_events_owner_task_seq ON app.campusmate_events (owner_id, task_id, seq);
CREATE INDEX campusmate_messages_owner_session_ord ON app.campusmate_messages (owner_id, session_id, ord);
CREATE INDEX campusmate_tasks_owner_session ON app.campusmate_tasks (owner_id, session_id);
CREATE INDEX campusmate_tasks_owner_status ON app.campusmate_tasks (owner_id, status);
CREATE INDEX campusmate_approvals_owner_task ON app.campusmate_approvals (owner_id, task_id);
CREATE INDEX campusmate_artifacts_owner_task ON app.campusmate_artifacts (owner_id, task_id);
CREATE INDEX campusmate_conversations_owner_updated ON app.campusmate_conversations (owner_id, updated_at);