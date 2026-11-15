import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildContext, ProductionDbRequiredError } from "../app-context.ts";
import { createApiServer } from "./server.ts";
import { InMemoryStore } from "../runtime/store.ts";
import { signJwt } from "./jwt.ts";

const SECRET = "s";

test("生产环境无 DATABASE_URL → 明确失败，不降级 InMemory", () => {
  assert.throws(() => buildContext({ NODE_ENV: "production" }), ProductionDbRequiredError);
});

test("开发环境无 DB → InMemory；有 DATABASE_URL → postgres", () => {
  assert.equal(buildContext({}).storeKind, "memory");
  assert.equal(buildContext({ DATABASE_URL: "postgresql://x:y@localhost:5432/db" }).storeKind, "postgres");
});

test("SSE /v1/tasks/:id/stream 推送事件与终态（query token 鉴权）", async () => {
  const store = new InMemoryStore();
  const server = createApiServer({ store, jwtSecret: SECRET });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = signJwt({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  try {
    const create = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ title: "x" }) });
    const { taskId } = (await create.json()) as { taskId: string };
    // 直接置终态，SSE 应立即推送 close。
    await store.updateTask(taskId, { status: "running" });
    await store.updateTask(taskId, { status: "succeeded", result: { summary: "done", artifactIds: [] } });
    const r = await fetch(`${base}/v1/tasks/${taskId}/stream?token=${token}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await r.text(); // 终态 → 服务端 res.end()，流结束
    assert.match(text, /event: task_status/);
    assert.match(text, /event: close/);
    assert.match(text, /succeeded/);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

test("SSE 无 token → 401", async () => {
  const store = new InMemoryStore();
  const server = createApiServer({ store, jwtSecret: SECRET });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const t = await store.createTask({ userId: "u1", title: "x" });
    const r = await fetch(`${base}/v1/tasks/${t.id}/stream`);
    assert.equal(r.status, 401);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});