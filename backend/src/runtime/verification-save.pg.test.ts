import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlitePool } from "./pglite-pool.ts";

test("verification RPC: atomicity, retry, historical preservation and invoker RLS", { timeout: 60_000 }, async t => {
  const pool = await PGlitePool.create();
  const root = new URL("../../../", import.meta.url);
  const migration = await readFile(new URL("supabase/migrations/0003_atomic_verification_reports.sql", root), "utf8");
  try {
    await pool.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;`);
    const base = (await readFile(new URL("supabase/migrations/0001_init.sql", root), "utf8")).replace(/create extension if not exists pgcrypto;/gi, "");
    await pool.exec(base); await pool.exec(migration);
    const opportunity = randomUUID();
    await pool.query("insert into opportunities(id,title,type,source_url) values($1,'fixture','competition','https://example.org/fixture')", [opportunity]);
    const payload = () => ({ id: randomUUID(), opportunity_id: opportunity, status: "UNVERIFIED", summary: "fixture", findings: [], evidence: [
      { source_url: "https://example.org/a", source_type: "official", excerpt: "a", retrieved_at: "2026-11-14T00:00:00Z", supports: "deadline", confidence: 0.9 },
      { source_url: "https://example.org/b", source_type: "official", excerpt: "b", retrieved_at: "2026-11-14T01:00:00Z", supports: "eligibility", confidence: 0.8 },
    ] });
    const save = async (value: unknown) => (await pool.query<{ result: any }>("select public.save_verification_report($1::jsonb) as result", [JSON.stringify(value)])).rows[0].result;
    const count = async (table: string, column: string, id: string) => (await pool.query<{ n: string }>(`select count(*)::text as n from ${table} where ${column}=$1`, [id])).rows[0].n;

    await t.test("successful save returns exactly the persisted report and evidence", async () => {
      const input = payload(); const result = await save(input);
      assert.equal(result.id, input.id); assert.equal(result.evidence_items.length, 2);
      assert.equal(await count("verification_reports", "id", input.id), "1");
      assert.equal(await count("evidence_items", "report_id", input.id), "2");
      assert.equal(new Date(result.evidence_items.find((e: any) => e.source_url.endsWith("/a")).retrieved_at).toISOString(), input.evidence[0].retrieved_at.replace("Z", ".000Z"));
    });
    await t.test("an evidence NOT NULL failure rolls back the parent; same id can then retry", async () => {
      const input = payload();
      await assert.rejects(save({ ...input, evidence: [{ ...input.evidence[0], source_url: null }] }), /not-null|null value/i);
      assert.equal(await count("verification_reports", "id", input.id), "0");
      assert.equal(await count("evidence_items", "report_id", input.id), "0");
      await save(input); assert.equal(await count("evidence_items", "report_id", input.id), "2");
    });
    await t.test("same-payload retries, reordered evidence and equivalent timestamps do not duplicate", async () => {
      const input = payload(); const first = await save(input);
      await save(input);
      await save({ ...input, evidence: [...input.evidence].reverse().map(e => ({ ...e, retrieved_at: new Date(e.retrieved_at).toISOString() })) });
      assert.equal(await count("evidence_items", "report_id", input.id), "2");
      assert.deepEqual(await save(input), first);
    });
    await t.test("a reused id with different content never overwrites historical report or evidence", async () => {
      const input = payload(); const first = await save(input);
      await assert.rejects(save({ ...input, summary: "must not overwrite" }), /different content/);
      await assert.rejects(save({ ...input, evidence: [] }), /different content/);
      assert.deepEqual(await save(input), first);
    });
    await t.test("empty evidence is allowed and does not invent facts", async () => {
      const input = { ...payload(), evidence: [] };
      assert.deepEqual((await save(input)).evidence_items, []);
      assert.deepEqual((await save(input)).evidence_items, []);
    });
    await t.test("RPC is invoker-only and authenticated callers still cannot write global reports", async () => {
      const info = await pool.query<{ elevated: boolean; anon_exec: boolean }>(`select prosecdef as elevated,
        has_function_privilege('anon','public.save_verification_report(jsonb)','EXECUTE') as anon_exec
        from pg_proc where oid='public.save_verification_report(jsonb)'::regprocedure`);
      assert.equal(info.rows[0].elevated, false); assert.equal(info.rows[0].anon_exec, false);
      await pool.exec("grant usage on schema public to authenticated; grant select,insert on verification_reports,evidence_items to authenticated; set role authenticated;");
      const input = payload();
      try { await assert.rejects(save(input), /row-level security/i); }
      finally { await pool.exec("reset role;"); }
      assert.equal(await count("verification_reports", "id", input.id), "0");
    });
    await t.test("invalid payloads reject and reapplying the migration preserves existing rows", async () => {
      await assert.rejects(save({ ...payload(), evidence: null }), /Invalid verification/);
      const input = payload(); const first = await save(input);
      await pool.exec(migration); assert.deepEqual(await save(input), first);
    });
  } finally { await pool.end(); }
});
