import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApiServer } from "./server.ts";
import { signJwt } from "./jwt.ts";
import { buildContext } from "../app-context.ts";

test("会话API仅允许认证owner读取，新建幂等，拒绝旧ID和非法cursor", async (t) => {
  const ctx = buildContext({});
  const server = createApiServer({ ...ctx, jwtSecret: "sessions-test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = randomUUID(); const other = randomUUID(); const id = randomUUID();
  const call = (path: string, uid = owner, body?: unknown) => fetch(base + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Authorization: `Bearer ${signJwt({ sub: uid, exp: Math.floor(Date.now() / 1000) + 60 }, "sessions-test")}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call("/v1/sessions", owner, { id, title: "身份" })).status, 201);
  assert.equal((await call("/v1/sessions", owner, { id })).status, 201);
  assert.equal(((await (await call("/v1/sessions")).json()) as { sessions: unknown[] }).sessions.length, 1);
  assert.deepEqual(((await (await call("/v1/sessions", other)).json()) as { sessions: unknown[] }).sessions, []);
  assert.equal((await call(`/v1/sessions/${id}/messages`, other)).status, 404);
  assert.equal((await call(`/v1/sessions/${id}/tasks`, other)).status, 404);
  assert.equal((await call(`/v1/sessions/${id}/messages?afterSeq=-1`)).status, 400);
  assert.equal((await call("/v1/sessions", owner, { id: "old-local-id" })).status, 400);
  assert.equal((await call("/v1/tasks", owner, { title: "test", sessionId: "old-local-id" })).status, 400);
});
