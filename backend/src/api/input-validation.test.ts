import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApiServer } from "./server.ts";
import { InMemoryStore } from "../runtime/store.ts";
import { signJwt } from "./jwt.ts";
import { DEFAULT_BUDGET } from "../core/types.ts";

test("API rejects malformed/oversized bodies, caps caller budgets, and limits query tokens to SSE", async () => {
  const store = new InMemoryStore();
  const server = createApiServer({ store, jwtSecret: "fixture", maxBodyBytes: 512 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = signJwt({ sub: "user-a", exp: Math.floor(Date.now() / 1000) + 3600 }, "fixture");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    assert.equal((await fetch(base + "/v1/tasks", { method: "POST", headers, body: "{" })).status, 400);
    assert.equal((await fetch(base + "/v1/tasks", { method: "POST", headers, body: JSON.stringify({ title: "x".repeat(600) }) })).status, 413);
    assert.equal((await fetch(base + "/v1/tasks", { method: "POST", headers, body: JSON.stringify({ title: "x", budget: { costUsd: -1 } }) })).status, 400);
    for (const sessionId of ["", "not-a-uuid", 123, {}, null]) {
      assert.equal((await fetch(base + "/v1/tasks", { method: "POST", headers, body: JSON.stringify({ title: "x", sessionId }) })).status, 400);
    }
    assert.equal((await fetch(base + "/v1/tasks", { method: "POST", headers, body: JSON.stringify({ title: "x", intent: {} }) })).status, 400);
    const result = await fetch(base + "/v1/tasks", { method: "POST", headers, body: JSON.stringify({ title: "x", budget: { tokens: 1e12, costUsd: 1e12, toolCalls: 1 } }) });
    assert.equal(result.status, 201);
    const body = await result.json() as { taskId: string };
    const task = await store.getTask(body.taskId);
    assert.equal(task?.budget.tokens, DEFAULT_BUDGET.tokens);
    assert.equal(task?.budget.costUsd, DEFAULT_BUDGET.costUsd);
    assert.equal(task?.budget.toolCalls, 1);
    const queryOnly = await fetch(base + `/v1/tasks?token=${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"title":"x"}' });
    assert.equal(queryOnly.status, 401);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
