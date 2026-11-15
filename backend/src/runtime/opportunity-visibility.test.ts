import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlitePool } from "./pglite-pool.ts";

// Break caught: a private opportunity's child tables retain universal public-read policies.
test("RLS：私有机会的来源、核验报告和证据对其他用户及匿名不可见，公共目录仍可读", async (t) => {
  const pool = await PGlitePool.create();
  t.after(() => pool.end());
  await pool.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  const root = new URL("../../../", import.meta.url);
  for (const path of [
    "supabase/migrations/0001_init.sql",
    "backend/migrations/0002_agent_runtime.sql",
    "backend/migrations/0003_personal_context.sql",
    "supabase/migrations/20261114061420_campusmate_shared_storage.sql",
  ]) {
    const sql = await fs.readFile(new URL(path, root), "utf8");
    await pool.exec(sql.replace(/create extension if not exists pgcrypto;/gi, ""));
  }
  const owner = randomUUID(), other = randomUUID();
  await pool.query("insert into auth.users(id) values($1),($2)", [owner, other]);
  const publicId = randomUUID(), privateId = randomUUID();
  for (const [id, visibility, title] of [[publicId, "public", "公开赛"], [privateId, "private", "私有项目方案"]]) {
    await pool.query("insert into opportunities(id,title,type,source_url,created_by,visibility) values($1,$2,'competition','https://school.example',$3,$4)", [id, title, owner, visibility]);
    await pool.query("insert into opportunity_sources(opportunity_id,url) values($1,$2)", [id, `https://school.example/${visibility}`]);
    const reportId = randomUUID();
    await pool.query("insert into verification_reports(id,opportunity_id,summary) values($1,$2,$3)", [reportId, id, title]);
    await pool.query("insert into evidence_items(report_id,source_url,excerpt) values($1,'https://school.example',$2)", [reportId, title]);
  }
  await pool.exec(`
    create role campusmate_visibility_reader;
    grant usage on schema public, auth to campusmate_visibility_reader;
    grant select on opportunities, opportunity_sources, verification_reports, evidence_items to campusmate_visibility_reader;
    set role campusmate_visibility_reader;
  `);
  for (const reader of [other, ""]) {
    await pool.query("select set_config('request.jwt.claim.sub',$1,false)", [reader]);
    assert.deepEqual((await pool.query<{ id: string }>("select id from opportunities")).rows.map((r) => r.id), [publicId]);
    assert.deepEqual((await pool.query<{ opportunity_id: string }>("select opportunity_id from opportunity_sources")).rows.map((r) => r.opportunity_id), [publicId], "来源也必须继承私有机会的可见性");
    assert.deepEqual((await pool.query<{ opportunity_id: string }>("select opportunity_id from verification_reports")).rows.map((r) => r.opportunity_id), [publicId], "报告不能泄漏私有方案");
    assert.deepEqual((await pool.query<{ excerpt: string }>("select excerpt from evidence_items")).rows.map((r) => r.excerpt), ["公开赛"], "证据摘录不能绕过父机会权限");
  }
  await pool.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  assert.equal((await pool.query("select id from opportunity_sources")).rows.length, 2);
  assert.equal((await pool.query("select id from verification_reports")).rows.length, 2);
  assert.equal((await pool.query("select id from evidence_items")).rows.length, 2);
});
