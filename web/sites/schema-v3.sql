-- P1 用户 BYOK Provider 元数据。密钥单独存 campusmate_secrets（AES-256-GCM）。
-- 只经 Sites function_backend 受审计迁移应用，不随 Function 打包。
-- 平台迁移不允许 DEFAULT：所有缺省值由 Function 写入时显式提供。
CREATE TABLE app.campusmate_providers (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  display_name text NOT NULL,
  base_url text NOT NULL,
  protocol text NOT NULL,
  model_id text NOT NULL,
  context_limit bigint,
  capabilities jsonb NOT NULL,
  has_key boolean NOT NULL,
  is_default boolean NOT NULL,
  deleted_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX campusmate_providers_owner ON app.campusmate_providers (owner_id);