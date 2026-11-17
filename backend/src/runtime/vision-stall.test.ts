import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER, contextFor, storageFixture } from "./storage-test-fixture.ts";
import { Worker } from "./worker.ts";
import type { SqlPool, SqlClient } from "./sql.ts";
const image = "data:image/png;base64," + "A".repeat(120000);

test("large image claim cannot consume the lease by returning the image before heartbeat starts", async t => {
  const fixture = await storageFixture(t); let clock = 1000;
  const original = await fixture.first.store.createTask({ userId: OWNER, title: "vision", images: [image] });
  const wrap = (client: SqlClient): SqlClient => ({ async query(sql, args) {
    const result = await client.query(sql, args);
    if (result.rows.some((row: any) => row.images?.length)) clock += 2000; // slow DB result transport
    return result as any;
  } });
  const pool: SqlPool = { query: fixture.pool.query.bind(fixture.pool), transaction: fn => fixture.pool.transaction(c => fn(wrap(c))), end: async () => {} };
  const ctx = contextFor(pool);
  const claimed = await ctx.store.claimNext({ workerId: "worker", leaseTtlMs: 1000, now: clock });
  assert(claimed); assert.equal(claimed.images, undefined); assert(claimed.lease.expiresAt! > clock);
  assert.deepEqual(await ctx.store.loadTaskImages(original.id, OWNER), [image]);
});

for (const mode of ["memory", "postgres"] as const) {
  test(`${mode}: expired claims pause at retry limit; manual resume fences the previous attempt`, async t => {
    const ctx = mode === "postgres" ? (await storageFixture(t)).first : contextFor();
    const session = await ctx.sessionStore.create({ userId: OWNER });
    const task = await ctx.store.createTask({ userId: OWNER, sessionId: session.id, title: "vision", maxAttempts: 1, images: [image] });
    await ctx.store.claimNext({ workerId: "worker", leaseTtlMs: 10, now: 1000 });
    const old = (await ctx.store.claimNext({ workerId: "worker", leaseTtlMs: 10, now: 1011 }))!;
    assert.equal(old.attempt, 1);
    assert.equal(await ctx.store.claimNext({ workerId: "worker", leaseTtlMs: 10, now: 1022 }), null);
    assert.equal((await ctx.store.getTask(task.id))?.status, "paused");
    assert((await ctx.store.listEvents(task.id)).some(e => e.type === "task.needs_input"));
    const resumed = await ctx.store.resumeSessionTask!(task.id, OWNER);
    assert(resumed.attempt > old.attempt);
    const next = (await ctx.store.claimNext({ workerId: "worker", leaseTtlMs: 1000, now: 1030 }))!;
    assert.equal(await ctx.store.renewLease(task.id, "worker", 1000, 1031, old.attempt), false);
    assert.equal(await ctx.store.renewLease(task.id, "worker", 1000, 1031, next.attempt), true);
    assert.deepEqual((await ctx.store.getTask(task.id))?.images, [image]);
  });
  test(`${mode}: text history omits image bytes while original message remains readable`, async t => {
    const ctx = mode === "postgres" ? (await storageFixture(t)).first : contextFor();
    const session = await ctx.sessionStore.create({ userId: OWNER });
    await ctx.sessionStore.appendMessage({ userId: OWNER, sessionId: session.id, turnId: "t", messageKey: "m", role: "user", content: [{ type: "text", text: "核验通知" }, { type: "image_url", image_url: { url: image } }] });
    const projected = await ctx.sessionStore.listMessages(OWNER, session.id, 0, { includeImages: false });
    assert(!JSON.stringify(projected).includes(image)); assert(JSON.stringify(projected).includes("核验通知"));
    assert(JSON.stringify(await ctx.sessionStore.listMessages(OWNER, session.id)).includes(image));
  });
}

test("image creation, session insertion and checkpoint writes do not echo the large input from SQL", async t => {
  const fixture = await storageFixture(t); const largeReturns: string[] = [];
  const observe = (client: SqlClient): SqlClient => ({ async query(sql, args) {
    const r = await client.query(sql, args);
    if ((/^\s*(?:insert|update)/i.test(sql) || /select \* from agent_tasks/i.test(sql)) && JSON.stringify(r.rows).includes(image)) largeReturns.push(sql.split(/\s/).slice(0, 3).join(" "));
    return r as any;
  } });
  const pool: SqlPool = { query: observe(fixture.pool).query, transaction: fn => fixture.pool.transaction(c => fn(observe(c))), end: async () => {} };
  const ctx = contextFor(pool); const session = await ctx.sessionStore.create({ userId: OWNER });
  const task = await ctx.store.createTask({ userId: OWNER, sessionId: session.id, title: "vision", images: [image] });
  assert.deepEqual(task.images, [image]);
  await ctx.sessionStore.appendMessage({ userId: OWNER, sessionId: session.id, taskId: task.id, turnId: "t", messageKey: "m", role: "user", content: [{ type: "image_url", image_url: { url: image } }] });
  await ctx.store.updateTask(task.id, { error: "diagnostic" });
  const state = { messages: [{ role: "user" as const, content: image }], repeat: {}, stepProgress: {}, usage: task.usage, pendingApprovals: [] };
  const cp = await ctx.store.writeCheckpoint({ taskId: task.id, userId: OWNER, eventSeq: 0, state });
  assert.deepEqual(cp.state, state); assert.deepEqual((await ctx.store.latestCheckpoint(task.id))?.state, state);
  assert.deepEqual(largeReturns, []);
});

test("newly admitted image payload is cached by owner, bounded by entries and expires", async t => {
  const fixture = await storageFixture(t); let imageReads = 0;
  const pool: SqlPool = { async query(sql, args) { if (/select images from agent_tasks/i.test(sql)) imageReads++; return fixture.pool.query(sql, args) as any; }, transaction: fn => fixture.pool.transaction(fn), end: async () => {} };
  const ctx = contextFor(pool);
  const task = await ctx.store.createTask({ userId: OWNER, title: "image", images: [image] });
  assert.deepEqual(await ctx.store.loadTaskImages(task.id, OWNER), [image]);
  assert.equal(imageReads, 0, "same-process admission must not download its own upload again");
  await assert.rejects(() => ctx.store.loadTaskImages(task.id, "22222222-2222-4222-8222-222222222222"), /owner/i);
  for (let i = 0; i < 32; i++) await ctx.store.createTask({ userId: OWNER, title: "cache-bound", images: [image] });
  const before = imageReads; await ctx.store.loadTaskImages(task.id, OWNER); assert.equal(imageReads, before + 1);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 600001 });
  await ctx.store.loadTaskImages(task.id, OWNER); assert.equal(imageReads, before + 2);
});

test("preparation time is part of the task budget before any model request", async () => {
  const ctx = contextFor(); let now = 1000, calls = 0;
  ctx.personalContext.getProfile = async () => { now += 100; return null; };
  const task = await ctx.store.createTask({ userId: OWNER, title: "vision", budget: { tokens: 10000, toolCalls: 10, wallMs: 50, costUsd: 1 } });
  await new Worker({ ...ctx, now: () => now, tools: [], buildSystem: () => "s", executeTool: async () => "{}", transport: { chat: async () => { calls++; return { content: "answer", toolCalls: [], usage: { input: 1, output: 1 }, model: "contract" }; } } }).tick();
  assert.equal(calls, 0); assert.equal((await ctx.store.getTask(task.id))?.status, "paused");
});
