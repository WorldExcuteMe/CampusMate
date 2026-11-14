import fs from "node:fs/promises";

// Explicit cross-directory history. This loader never applies SQL or reads credentials.
export const MIGRATION_PATHS = [
  "supabase/migrations/0001_init.sql",
  "backend/migrations/0002_agent_runtime.sql",
  "backend/migrations/0003_personal_context.sql",
  "supabase/migrations/20261114061420_campusmate_shared_storage.sql",
] as const;

export async function readMigrations() {
  const root = new URL("../../../", import.meta.url);
  return await Promise.all(MIGRATION_PATHS.map(async (path) => ({ path, sql: await fs.readFile(new URL(path, root), "utf8") })));
}
