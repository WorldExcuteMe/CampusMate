import { test } from "node:test";
import assert from "node:assert/strict";
import { Evaluator, buildEvaluationInput } from "./evaluator.ts";
import { InMemoryEvidenceStore } from "./evidence.ts";
import { sanitizeProposedStatus, canPersistVerified, resolveVerifiedStatus, detectConflict } from "./verification.ts";
import type { AcceptanceCriterion } from "./types.ts";

const crit = (id: string, kind: AcceptanceCriterion["kind"], params: Record<string, unknown> = {}, required = true): AcceptanceCriterion => ({ id, kind, params, required });
const fetchOk = (body: string) => async () => ({ status: 200, text: body });
const fetchFail = async () => ({ status: 404, text: "" });

test("缺证据 → evidence_verified 拒绝，证书 passed=false", async () => {
  const store = new InMemoryEvidenceStore();
  const ev = new Evaluator({ evidenceStore: store, fetchImpl: fetchOk("x") });
  const cert = await ev.evaluate("t1", [crit("c1", "evidence_verified", { min: 1 })], buildEvaluationInput({ reply: "声称成功", evidence: [] }));
  assert.equal(cert.passed, false);
  assert.equal(cert.evaluatedBy, "evaluator");
});

test("幻觉证据（excerpt 与正文不符）→ 拒绝", async () => {
  const store = new InMemoryEvidenceStore();
  const e = await store.add({ taskId: "t1", userId: "u1", sourceUrl: "https://example.org/comp", excerpt: "报名截止2026年11月30日", supports: "deadline" });
  const ev = new Evaluator({ evidenceStore: store, fetchImpl: fetchOk("完全不同的页面内容，没有截止日期") });
  const cert = await ev.evaluate("t1", [crit("c1", "evidence_verified")], buildEvaluationInput({ reply: "x", evidence: [e] }));
  assert.equal(cert.passed, false);
  assert.equal((await store.get(e.id))?.verified, false);
});

test("重抓失败（404）→ 证据不核验", async () => {
  const store = new InMemoryEvidenceStore();
  const e = await store.add({ taskId: "t1", userId: "u1", sourceUrl: "https://example.org/x", excerpt: "报名截止2026年11月30日", supports: "deadline" });
  const ev = new Evaluator({ evidenceStore: store, fetchImpl: fetchFail });
  const cert = await ev.evaluate("t1", [crit("c1", "evidence_verified")], buildEvaluationInput({ reply: "x", evidence: [e] }));
  assert.equal(cert.passed, false);
});

test("证据独立重抓比对一致 → 通过，证据标记 verified", async () => {
  const store = new InMemoryEvidenceStore();
  const e = await store.add({ taskId: "t1", userId: "u1", sourceUrl: "https://example.org/comp", excerpt: "报名截止2026年11月30日", supports: "deadline" });
  const ev = new Evaluator({ evidenceStore: store, fetchImpl: fetchOk("2026计算机竞赛通知：报名截止2026年11月30日，欢迎参加。") });
  const cert = await ev.evaluate("t1", [crit("c1", "evidence_verified")], buildEvaluationInput({ reply: "x", evidence: [e] }));
  assert.equal(cert.passed, true);
  assert.equal((await store.get(e.id))?.verified, true);
  assert.ok(cert.criteria[0].evidenceIds.includes(e.id));
});

test("多条验收：required 全过才 passed；非 required 失败不阻断", async () => {
  const store = new InMemoryEvidenceStore();
  const ev = new Evaluator({ evidenceStore: store, fetchImpl: fetchOk("x") });
  const input = buildEvaluationInput({ reply: "x", fields: { title: "竞赛" }, counts: { inbox: 3 }, citedSources: ["https://a"] });
  const cert = await ev.evaluate("t1", [crit("c1", "field_present", { field: "title" }), crit("c2", "count_min", { key: "inbox", min: 2 }), crit("c3", "source_cited"), crit("c4", "no_expired", {}, false)], input);
  assert.equal(cert.passed, true);
  const cert2 = await ev.evaluate("t1", [crit("c1", "field_present", { field: "missing" })], input);
  assert.equal(cert2.passed, false);
});

test("模型自填 VERIFIED → 降级 UNVERIFIED", () => {
  assert.equal(sanitizeProposedStatus("VERIFIED"), "UNVERIFIED");
  assert.equal(sanitizeProposedStatus("CONFLICTING"), "CONFLICTING");
});

test("VERIFIED 落库门控：需 evaluator + 全部证据 verified", () => {
  assert.equal(canPersistVerified({ evaluatedBy: "pending", evidenceCount: 1, evidenceVerifiedCount: 1 }), false);
  assert.equal(canPersistVerified({ evaluatedBy: "evaluator", evidenceCount: 0, evidenceVerifiedCount: 0 }), false);
  assert.equal(canPersistVerified({ evaluatedBy: "evaluator", evidenceCount: 2, evidenceVerifiedCount: 1 }), false);
  assert.equal(canPersistVerified({ evaluatedBy: "evaluator", evidenceCount: 1, evidenceVerifiedCount: 1 }), true);
});

test("resolveVerifiedStatus：全核验→VERIFIED，部分→PARTIALLY，无→UNVERIFIED，冲突保留", () => {
  const ve = (verified: boolean) => ({ id: "e", taskId: "t", userId: "u", sourceUrl: "https://a", excerpt: "x", supports: "s", confidence: 1, retrievedAt: 1, verified });
  assert.equal(resolveVerifiedStatus("VERIFIED", [ve(true)]).status, "VERIFIED");
  assert.equal(resolveVerifiedStatus("VERIFIED", [ve(true), ve(false)]).status, "PARTIALLY_VERIFIED");
  assert.equal(resolveVerifiedStatus("VERIFIED", [ve(false)]).status, "UNVERIFIED");
  assert.equal(resolveVerifiedStatus("CONFLICTING", [ve(true)]).status, "CONFLICTING");
});

test("冲突检测：同字段不同值 → CONFLICTING", () => {
  assert.equal(detectConflict(["2026-11-20", "2026-11-30"]), true);
  assert.equal(detectConflict(["2026-11-20", "2026-11-20"]), false);
  assert.equal(detectConflict(["2026-11-20", ""]), false);
});