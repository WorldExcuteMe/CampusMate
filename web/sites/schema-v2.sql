-- P1 server-model vault + executor checkpoint columns.
CREATE TABLE app.campusmate_secrets (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  updated_at bigint NOT NULL
);
ALTER TABLE app.campusmate_tasks ADD COLUMN checkpoint jsonb;
ALTER TABLE app.campusmate_tasks ADD COLUMN provider_id text;
ALTER TABLE app.campusmate_tasks ADD COLUMN runtime text;
