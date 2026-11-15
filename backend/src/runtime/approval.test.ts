import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { InMemoryApprovalStore, requiresApproval } from "./approval.ts";
import { createApiServer } from "../api/server.ts";
import { InMemoryStore } from "./store.ts";
import { signJwt } from "../api/jwt.ts";

const SECRET = "s";
const input = (taskId: string, userId: string, key: string) => ({ taskId, userId, toolName: "run_terminal", args: { command: "ls" }, idempotencyKey: key, risk: "exec" });

test("审批状态机 pending→approved/rejected，终态不可改", async () => {
  const s = new InMemoryApprovalStore();
  const a = await s.create(input("t1", "u1", "k1"));
  assert.equal(a.status, "pending");
  const ok = await s.decide(a.id, "u1", "approved");
  assert.equal(ok?.status, "approved");
  const again = await s.decide(a.id, "u1", "rejected");
  assert.equal(again?.status, "approved"); // 终态锁定
});

test("审批 owner 隔离 + 同键复用", async () => {
  const s = new InMemoryApprovalStore();
  const a = await s.create(input("t1", "u1", "k1"));
  assert.equal(await s.decide(a.id, "u2", "approved"), null); // 跨用户
  const dup = await s.create(input("t1", "u1", "k1"));
  assert.equal(dup.id, a.id); // 同 (task,key) 复用
  assert.equal((await s.listPendingByUser("u1")).length, 1);
  assert.equal((await s.listPendingByUser("u2")).length, 0);
});

test("高危判定：本机/全局写需审批，云只读不需要", () => {
  assert.equal(requiresApproval("run_terminal", {}).required, true);
  assert.equal(requiresApproval("write_file", {}).required, true);
  assert.equal(requiresApproval("create_opportunity", {}).required, true);
  assert.equal(requiresApproval("web_search", {}).required, false);
  assert.equal(requiresApproval("web_fetch", {}).required, false);
});

async function withServer(fn: (base: string, approvals: InMemoryApprovalStore) => Promise<void>): Promise<void> {
  const store = new InMemoryStore();
  const approvals = new InMemoryApprovalStore();
  const server = createApiServer({ store, jwtSecret: SECRET, approvals });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await fn(base, approvals); } finally { await new Promise<void>((r) => server.close(() => r())); }
}
const auth = (uid: string) => ({ Authorization: `Bearer ${signJwt({ sub: uid, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)}` });
const jbody = (r: Response): Promise<any> => r.json() as Promise<any>;

test("审批 API：列表 + 决策（owner）+ 跨用户 404", async () => {
  await withServer(async (base, approvals) => {
    const a = await approvals.create(input("t1", "u1", "k1"));
    const list = await fetch(`${base}/v1/approvals`, { headers: auth("u1") });
    assert.equal((await jbody(list)).approvals.length, 1);
    const decide = await fetch(`${base}/v1/approvals/${a.id}`, { method: "POST", headers: { "Content-Type": "application/json", ...auth("u1") }, body: JSON.stringify({ decision: "approved" }) });
    assert.equal((await jbody(decide)).approval.status, "approved");
    const cross = await fetch(`${base}/v1/approvals/${a.id}`, { method: "POST", headers: { "Content-Type": "application/json", ...auth("u2") }, body: JSON.stringify({ decision: "rejected" }) });
    assert.equal(cross.status, 404);
    const bad = await fetch(`${base}/v1/approvals/${a.id}`, { method: "POST", headers: { "Content-Type": "application/json", ...auth("u1") }, body: JSON.stringify({ decision: "maybe" }) });
    assert.equal(bad.status, 400);
  });
});