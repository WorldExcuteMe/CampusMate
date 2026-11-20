-- P0 私有运行账本：整行版本 CAS 同时保护运行预约和有限测试额度。
-- 仅通过 Sites function_backend 的受审迁移应用，不随 Function ZIP 打包。
CREATE TABLE app.campusmate_runtime (
  id text PRIMARY KEY,
  version integer NOT NULL DEFAULT 1,
  runs jsonb NOT NULL,
  meter jsonb NOT NULL
);

-- 协调器租约行：version 围栏同一行的接管与记录写入，token 标识当前持有者。
-- record 保存官方 ensureCloudResources 的创建记录；未知状态必须原样保留，
-- 租约接管与释放只改租约字段，绝不能覆盖 record。
CREATE TABLE app.campusmate_locks (
  lock_key text PRIMARY KEY,
  version integer NOT NULL DEFAULT 1,
  token text NOT NULL,
  expires_at bigint NOT NULL,
  record jsonb
);
