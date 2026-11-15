// Local-only real Postgres/PostgREST verification. Never exposes admin keys to a browser.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "web/package.json"));
const { createClient } = require("@supabase/supabase-js");
const { stdout } = await promisify(execFile)(process.execPath, [resolve(root, "node_modules/supabase/dist/supabase.js"), "--workdir", resolve(root, ".local/dev"), "status", "-o", "json"], { windowsHide: true });
const info = JSON.parse(stdout);
const api = info.API_URL ?? info.api_url;
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(api).hostname), "Only local verification is allowed");
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = createClient(api, info.SERVICE_ROLE_KEY ?? info.service_role_key ?? info.SECRET_KEY ?? info.secret_key, options);
const anonKey = info.ANON_KEY ?? info.anon_key ?? info.PUBLISHABLE_KEY ?? info.publishable_key;
const guest = createClient(api, anonKey, options);
const ok = response => { if (response.error) throw new Error(response.error.message); return response.data; };
const check = (name, value) => { assert.ok(value, name); console.log("PASS", name); };
const opportunityId = randomUUID(), reportId = randomUUID();
const title = `verification-save-smoke-${randomUUID()}`;
let userId, opportunityCreated = false;
try {
  ok(await admin.from("opportunities").insert({ id: opportunityId, title, type: "competition", source_url: "https://example.org/fixture" }));
  opportunityCreated = true;
  const payload = { id: reportId, opportunity_id: opportunityId, status: "UNVERIFIED", summary: "fixture", findings: [], evidence: [
    { source_url: "https://example.org/a", source_type: "official", excerpt: "fixture a", retrieved_at: "2026-11-14T00:00:00Z", supports: "deadline", confidence: 0.9 },
    { source_url: "https://example.org/b", source_type: "official", excerpt: "fixture b", retrieved_at: "2026-11-14T01:00:00Z", supports: "eligibility", confidence: 0.8 },
  ] };
  const save = p_report => admin.rpc("save_verification_report", { p_report });
  const bad = await save({ ...payload, evidence: [{ ...payload.evidence[0], source_url: null }] });
  check("Evidence failure is rejected", bad.error?.code === "23502");
  check("Failed transaction leaves no parent report", ok(await admin.from("verification_reports").select("id").eq("id", reportId)).length === 0);
  check("Failed transaction leaves no evidence", ok(await admin.from("evidence_items").select("id").eq("report_id", reportId)).length === 0);
  const saved = ok(await save(payload));
  check("Retry saves report and all evidence", saved.id === reportId && saved.evidence_items.length === 2);
  const concurrent = await Promise.all([save(payload), save({ ...payload, evidence: [...payload.evidence].reverse() }), save(payload)]);
  concurrent.forEach(ok);
  const persisted = ok(await admin.from("verification_reports").select("*,evidence_items(*)").eq("id", reportId).single());
  check("Concurrent same-id retries do not duplicate evidence", persisted.evidence_items.length === 2 && persisted.created_at === saved.created_at);
  const conflict = await save({ ...payload, summary: "must-not-overwrite" });
  check("Conflicting retry is rejected without overwrite", conflict.error?.code === "23505" && ok(await admin.from("verification_reports").select("summary").eq("id", reportId).single()).summary === payload.summary);
  check("Anonymous RPC access is denied", Boolean((await guest.rpc("save_verification_report", { p_report: { ...payload, id: randomUUID() } })).error));
  const password = randomBytes(20).toString("hex");
  const email = `verification-save-${randomUUID()}@example.com`;
  userId = ok(await admin.auth.admin.createUser({ email, password, email_confirm: true })).user.id;
  const user = createClient(api, anonKey, options);
  ok(await user.auth.signInWithPassword({ email, password }));
  const deniedId = randomUUID();
  const denied = await user.rpc("save_verification_report", { p_report: { ...payload, id: deniedId } });
  check("Authenticated user cannot bypass existing global-report RLS", denied.error?.code === "42501");
  check("Permission failure leaves no report", ok(await admin.from("verification_reports").select("id").eq("id", deniedId)).length === 0);
  console.log("LOCAL_VERIFICATION_SAVE_VERIFIED");
} finally {
  if (opportunityCreated) {
    const own = ok(await admin.from("opportunities").select("title").eq("id", opportunityId).single());
    assert.equal(own.title, title, "Cleanup must target only this exact random fixture");
    ok(await admin.from("opportunities").delete().eq("id", opportunityId));
  }
  if (userId) ok(await admin.auth.admin.deleteUser(userId));
  console.log("PASS temporary report/evidence/account fixtures cleaned; existing data untouched");
}
