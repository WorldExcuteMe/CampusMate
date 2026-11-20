-- P1 personal tables: owner_id isolation enforced by function predicates.
CREATE TABLE app.campusmate_conversations (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  title text NOT NULL,
  mode text NOT NULL DEFAULT 'auto',
  archived boolean NOT NULL DEFAULT false,
  deleted_at bigint,
  revision integer NOT NULL DEFAULT 0,
  cloud_session_id text,
  agent_id text,
  agent_version integer,
  environment_id text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE TABLE app.campusmate_tasks (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  session_id text NOT NULL,
  turn_id text NOT NULL,
  title text NOT NULL,
  intent text,
  status text NOT NULL DEFAULT 'queued',
  usage jsonb NOT NULL,
  result jsonb,
  error text,
  seq_counter integer NOT NULL DEFAULT 0,
  cancel_requested boolean NOT NULL DEFAULT false,
  last_cloud_event_id text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE TABLE app.campusmate_events (
  id text PRIMARY KEY,
  task_id text NOT NULL,
  owner_id text NOT NULL,
  seq integer NOT NULL,
  cloud_event_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at bigint NOT NULL
);
CREATE TABLE app.campusmate_messages (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  session_id text NOT NULL,
  turn_id text NOT NULL,
  task_id text,
  role text NOT NULL,
  content text NOT NULL,
  ord integer NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE TABLE app.campusmate_approvals (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  task_id text NOT NULL,
  tool_name text NOT NULL,
  args jsonb NOT NULL,
  risk text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at bigint NOT NULL,
  decided_at bigint
);
CREATE TABLE app.campusmate_artifacts (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  task_id text NOT NULL,
  cloud_file_id text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size bigint NOT NULL,
  sha256 text,
  inline jsonb,
  created_at bigint NOT NULL
);
CREATE TABLE app.campusmate_settings (
  owner_id text PRIMARY KEY,
  data jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);
CREATE TABLE app.campusmate_inbox (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  data jsonb NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE TABLE app.campusmate_daily (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  data jsonb NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE TABLE app.campusmate_opportunities (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  data jsonb NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE TABLE app.campusmate_profile (
  owner_id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at bigint NOT NULL
);
