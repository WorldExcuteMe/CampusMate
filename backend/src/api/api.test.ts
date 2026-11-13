import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApiServer } from "./server.ts";
import { InMemoryStore } from "../runtime/store.ts";
import { verifySupabaseJwt, signJwt, bearerToken } from "./jwt.ts";

const SECRET = "test-secret";
const jbody = (r: Response): Promise<any> => r.json() as Promise<any>;

test("JWT 验签：有效/过期/坏签名/错 alg", () => {
  const now = 1_000_000;
  const good = signJwt({ sub: "u1", exp: now + 3600 }, SECRET);
  assert.equal(verifySupabaseJwt(good, SECRET, now)?.sub, "u1");
  assert.equal(verifySupabaseJwt(good, "wrong-secret", now), null);
  const expired = signJwt({ sub: "u1", exp: now - 10 }, SECRET);
  assert.equal(verifySupabaseJwt(expired, SECRET, now), null);
  const noSub = signJwt({ exp: now + 3600 }, SECRET);
  assert.equal(verifySupabaseJwt(noSub, SECRET, now), null);
  assert.equal(verifySupabaseJwt("garbage", SECRET, now), null);
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken(undefined), null);
});

async function withServer(fn: (base: string, store: InMemoryStore) => Promise<void>): Promise<void> {
  const store = new InMemoryStore();
  const server = createApiServer({ store, jwtSecret: SECRET, storeKind: "memory" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try { await fn(`http://127.0.0.1:${port}`, store); }
  finally { await new Promise<void>((r) => server.close(() => r())); }
}

const auth = (uid: string) => ({ Authorization: `Bearer ${signJwt({ sub: uid, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)}` });

test("health 无需鉴权", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/v1/health`);
    assert.equal(r.status, 200);
    assert.equal((await jbody(r)).ok, true);
  });
});

test("提交任务需 JWT；无 token → 401", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "x" }) });
    assert.equal(r.status, 401);
  });
});

test("提交→查询→事件→取消（owner）", async () => {
  await withServer(async (base) => {
    const create = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { "Content-Type": "application/json", ...auth("u1") }, body: JSON.stringify({ title: "收集竞赛" }) });
    assert.equal(create.status, 201);
    const { taskId } = await jbody(create);
    const get = await fetch(`${base}/v1/tasks/${taskId}`, { headers: auth("u1") });
    assert.equal(get.status, 200);
    assert.equal((await jbody(get)).task.status, "queued");
    const ev = await fetch(`${base}/v1/tasks/${taskId}/events`, { headers: auth("u1") });
    assert.ok((await jbody(ev)).events.length >= 1);
    const cancel = await fetch(`${base}/v1/tasks/${taskId}/cancel`, { method: "POST", headers: auth("u1") });
    assert.equal((await jbody(cancel)).ok, true);
  });
});

test("跨用户访问 → 403", async () => {
  await withServer(async (base) => {
    const create = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { "Content-Type": "application/json", ...auth("u1") }, body: JSON.stringify({ title: "x" }) });
    const { taskId } = await jbody(create);
    const get = await fetch(`${base}/v1/tasks/${taskId}`, { headers: auth("u2") });
    assert.equal(get.status, 403);
    const cancel = await fetch(`${base}/v1/tasks/${taskId}/cancel`, { method: "POST", headers: auth("u2") });
    assert.equal(cancel.status, 403);
  });
});

test("缺 title → 400；不存在任务 → 404", async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { "Content-Type": "application/json", ...auth("u1") }, body: JSON.stringify({}) });
    assert.equal(bad.status, 400);
    const nf = await fetch(`${base}/v1/tasks/00000000-0000-0000-0000-000000000000`, { headers: auth("u1") });
    assert.equal(nf.status, 404);
  });
});