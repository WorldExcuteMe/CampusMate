import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApiServer } from "./server.ts";
import { InMemoryStore } from "../runtime/store.ts";
import { InMemoryPersonalContextStore } from "../core/personal-context.ts";
import { signJwt } from "./jwt.ts";

const SECRET = "s";
const CSV = "courseName,weekday,startTime,endTime,startWeek,endWeek,weekPattern,classroom,campus\n高数,1,08:00,09:40,1,16,every,A101,主校区";

async function withServer(fn: (base: string, token: string) => Promise<void>) {
  const store = new InMemoryStore();
  const pc = new InMemoryPersonalContextStore();
  const server = createApiServer({ store, jwtSecret: SECRET, personalContext: pc });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = signJwt({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  try { await fn(base, token); } finally { await new Promise<void>((r) => server.close(() => r())); }
}
const post = (base: string, token: string, wf: string, body: unknown) => fetch(`${base}/v1/workflows/${wf}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const j = (r: Response): Promise<any> => r.json() as Promise<any>;

test("工作流 API：onboarding 预览→确认（owner 隔离）", async () => {
  await withServer(async (base, token) => {
    const input = { university: "某大学", major: "计算机", grade: "大二", term: { name: "2026秋", startDate: "2026-09-01", endDate: "2027-01-15", totalWeeks: 20 }, schedule: { format: "csv", data: CSV } };
    const preview = await j(await post(base, token, "onboarding", input));
    assert.equal(preview.status, "needs_confirm");
    const done = await j(await post(base, token, "onboarding", { ...input, confirm: true }));
    assert.equal(done.status, "completed");
    assert.equal(done.savedSchedules, 1);
    const terms = await j(await fetch(`${base}/v1/terms`, { headers: { Authorization: `Bearer ${token}` } }));
    assert.equal(terms.terms.length, 1);
  });
});

test("工作流 API：inbox 派生 + opportunities 推荐 + weekly-plan", async () => {
  await withServer(async (base, token) => {
    const inbox = await j(await post(base, token, "inbox", { title: "ACM", rawText: "x", category: "competition", deadline: "2026-11-16", isOpportunity: true }));
    assert.ok(inbox.objects.some((o: { kind: string }) => o.kind === "opportunity"));
    const opps = await j(await post(base, token, "opportunities", { profile: { userId: "u1", university: "x", major: "计算机", grade: "大二", interests: [], skills: ["Python"], goals: [], preferences: {}, updatedAt: 1 }, opportunities: [{ id: "o1", title: "Python 竞赛", type: "competition", skills: ["Python"], verified: true }] }));
    assert.equal(opps.recommendations[0].id, "o1");
    const plan = await j(await post(base, token, "weekly-plan", { goal: "准备竞赛", schedules: [], tasks: [{ id: "t1", title: "准备", dueAt: "2026-11-20", estimateHours: 2 }], week: 1 }));
    assert.ok(plan.plan.steps.length >= 3);
  });
});

test("工作流 API：无 token → 401", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/v1/workflows/inbox`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
  });
});