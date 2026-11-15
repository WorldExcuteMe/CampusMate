// Real local Auth + REST + RLS smoke. Creates only random fixture users/data,
// records private credentials in a gitignored file for a restart probe, then cleans them.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workdir = path.join(root, ".local", "dev");
const require = createRequire(path.join(root, "web", "package.json"));
const { createClient } = require("@supabase/supabase-js");
const exec = promisify(execFile);
const { stdout } = await exec(process.execPath, [path.join(root, "node_modules/supabase/dist/supabase.js"), "--workdir", workdir, "status", "-o", "json"], { windowsHide: true });
const info = JSON.parse(stdout);
const api = info.API_URL ?? info.api_url;
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(api).hostname), "Only localhost smoke tests are allowed");
const anon = info.ANON_KEY ?? info.anon_key ?? info.PUBLISHABLE_KEY ?? info.publishable_key;
const service = info.SERVICE_ROLE_KEY ?? info.service_role_key ?? info.SECRET_KEY ?? info.secret_key;
assert.ok(anon && service, "Missing local API keys");
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = createClient(api, service, options);
const filename = path.join(workdir, "db-smoke-fixture.json");
const mode = process.argv[2] ?? "verify";
const check = (name, condition) => { assert.ok(condition, name); console.log("PASS", name); };
const ok = (response) => { if (response.error) throw new Error(response.error.message); return response.data; };
let fixture;
try {
  if (mode === "resume") {
    fixture = JSON.parse(await fs.readFile(filename, "utf8"));
  } else {
    fixture = { users: [], password: randomBytes(20).toString("hex"), taskId: randomUUID(), title: `local-db-smoke-${randomUUID()}`, sessionId: randomUUID() };
    for (const suffix of ["a", "b"]) {
      const email = `campusmate-smoke-${randomUUID()}-${suffix}@example.com`;
      const result = suffix === "a" ? ok(await createClient(api, anon, options).auth.signUp({ email, password: fixture.password }))
        : ok(await admin.auth.admin.createUser({ email, password: fixture.password, email_confirm: true }));
      const user = result.user;
      fixture.users.push({ id: user.id, email });
      if (suffix === "a") check("Local registration returns a signed-in session", Boolean(result.session));
    }
    await fs.writeFile(filename, JSON.stringify(fixture), { mode: 0o600 });
  }
  const clients = [];
  for (const user of fixture.users) {
    const client = createClient(api, anon, options);
    ok(await client.auth.signInWithPassword({ email: user.email, password: fixture.password }));
    clients.push(client);
    const profile = ok(await client.from("profiles").select("id").eq("id", user.id).single());
    check("Auth login and signup profile trigger", profile.id === user.id);
  }
  const [a, b] = clients;
  if (mode !== "resume") ok(await a.from("tasks").insert({ id: fixture.taskId, user_id: fixture.users[0].id, title: fixture.title, status: "todo", kind: "daily" }));
  const own = ok(await a.from("tasks").select("id,title").eq("id", fixture.taskId));
  check(mode === "resume" ? "Docker stop/start retained the saved task" : "Owner reads real persisted task", own.length === 1 && own[0].title === fixture.title);
  check("Other authenticated account cannot read the task", ok(await b.from("tasks").select("id").eq("id", fixture.taskId)).length === 0);
  check("Other account cannot update the task", ok(await b.from("tasks").update({ title: "must-not-change" }).eq("id", fixture.taskId).select("id")).length === 0);
  const forbidden = await b.from("tasks").insert({ user_id: fixture.users[0].id, title: "forged owner" });
  check("RLS rejects forged owner insertion", Boolean(forbidden.error));
  const guest = createClient(api, anon, options);
  check("Unauthenticated account cannot read private tasks", ok(await guest.from("tasks").select("id").eq("id", fixture.taskId)).length === 0);
  ok(await a.from("tasks").update({ status: "done" }).eq("id", fixture.taskId));
  check("Completion persists", ok(await a.from("tasks").select("status").eq("id", fixture.taskId).single()).status === "done");
  const { PgPool } = await import("../backend/src/runtime/sql.ts");
  const { PostgresStore } = await import("../backend/src/runtime/postgres-store.ts");
  const database = new URL(info.DB_URL ?? info.db_url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
  database.searchParams.set("sslmode", "disable");
  const pool = new PgPool(database.href);
  try {
    const store = new PostgresStore(pool);
    if (mode !== "resume") {
      const first = await store.createTask({ userId: fixture.users[0].id, sessionId: fixture.sessionId, title: "记住测试项目蓝鲸" });
      await store.updateTask(first.id, { status: "running" });
      await store.updateTask(first.id, { status: "succeeded", result: { summary: "已记住蓝鲸", artifactIds: [] } });
      fixture.anchorId = (await store.createTask({ userId: fixture.users[0].id, sessionId: fixture.sessionId, title: "刚才项目叫什么" })).id;
      await fs.writeFile(filename, JSON.stringify(fixture), { mode: 0o600 });
    }
    const q = { userId: fixture.users[0].id, sessionId: fixture.sessionId, beforeTaskId: fixture.anchorId };
    check("Runtime reads prior conversation from real SQL", (await store.listSessionHistory(q)).map(m => m.content).join("|") === "记住测试项目蓝鲸|已记住蓝鲸");
    check("Runtime session cannot be read with another owner", (await store.listSessionHistory({ ...q, userId: fixture.users[1].id })).length === 0);
  } finally { await pool.end(); }
  if (mode === "prepare") console.log("Restart fixture retained; run db:stop, db:start, then npm run db:verify -- resume.");
  else console.log("LOCAL_DB_VERIFIED");
} finally {
  if (mode !== "prepare" && fixture) {
    for (const user of fixture.users) ok(await admin.auth.admin.deleteUser(user.id));
    await fs.rm(filename, { force: true }); // Exact fixture file only, never a data directory.
  }
}
