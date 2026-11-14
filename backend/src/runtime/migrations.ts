import fs from "node:fs/promises";

// Explicit cross-directory history. This loader never applies SQL or reads credentials.
export const MIGRATION_PATHS = [
  "supabase/migrations/0001_init.sql",
  "backend/migrations/0002_agent_runtime.sql",
  "backend/migrations/0003_personal_context.sql",
  "supabase/migrations/20261114061420_campusmate_shared_storage.sql",
  "supabase/migrations/20261114113238_campusmate_session_turns.sql",
  "supabase/migrations/20261114120851_campusmate_model_routing.sql",
  "supabase/migrations/20261114171524_campusmate_calendar.sql",
] as const;

export async function readMigrations() {
  const root = new URL("../../../", import.meta.url);
  return await Promise.all(MIGRATION_PATHS.map(async (path) => ({ path, sql: await fs.readFile(new URL(path, root), "utf8") })));
}
