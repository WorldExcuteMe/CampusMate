import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER, OTHER, contextFor, storageFixture } from "./storage-test-fixture.ts";
for (const mode of ["memory", "postgres"] as const) test(`${mode}: session task lists isolate owner/session and omit image payloads without deleting execution input`, async t => {
  const ctx = mode === "postgres" ? (await storageFixture(t)).first : contextFor();
  const a = await ctx.sessionStore.create({ userId: OWNER }); const b = await ctx.sessionStore.create({ userId: OWNER });
  const images = ["data:image/png;base64," + "A".repeat(100000)];
  const current = await ctx.store.createTask({ userId: OWNER, sessionId: a.id, title: "current", images });
  await ctx.store.createTask({ userId: OWNER, sessionId: b.id, title: "other-session", images });
  const rows = await ctx.store.listSessionTasks(OWNER, a.id);
  assert.deepEqual(rows.map(row => row.id), [current.id]); assert.equal(rows[0].images, undefined);
  assert.deepEqual(await ctx.store.listSessionTasks(OTHER, a.id), []);
  assert.equal((await ctx.store.getTask(current.id, { includeImages: false }))?.images, undefined);
  assert.deepEqual((await ctx.store.getTask(current.id))?.images, images);
});
