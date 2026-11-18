// Target 通道自测：scripted（核心循环）与 api-memory（HTTP+Worker+内存库）。
// 不依赖评测器/报告器，直接断言统一观测结构，便于定位通道本身的回归。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ScriptedTarget } from "./scripted.ts";
import { ApiTarget } from "./api.ts";
import type { EvalCase, TargetOptions } from "../types.ts";
import { observedTokenTotal } from "../trace.ts";
import { parseSourceBindings } from "./source-binding.ts";

const options: TargetOptions = { concurrency: 2, defaultTimeoutMs: 30_000, offlineTools: true, now: Date.now };

test("取消前已完成的模型轮次仍计入使用量", () => {
  assert.equal(observedTokenTotal([
    { usage: { inputTotal: 3680, output: 28 } }, { usage: { inputTotal: 3871, output: 51 } },
    { usage: { inputTotal: 4075, output: 161 } }, { usage: { inputTotal: null, output: null } },
  ]), 11866);
});

test("真实课表授权只绑定所选用例，要求独立摘要和合法学期", () => {
  const digest = "a".repeat(64);
  const source = { grants: [{ id: "course", label: "个人课表", dataset: "timetable", url: "https://example.test/export", format: "ics" }],
    sourceId: "course", sha256: digest, scheduleDigest: digest };
  assert.throws(() => parseSourceBindings({ "CASE-1": source }, new Set(["CASE-2"])), /未选定/);
  assert.throws(() => parseSourceBindings({ "CASE-1": source }, new Set(["CASE-1"])), /学期元数据/);
  const term = { name: "春季学期", startDate: "2027-03-01", endDate: "2027-07-04", totalWeeks: 18, timezone: "Asia/Shanghai" };
  assert.deepEqual(parseSourceBindings({ "CASE-1": { ...source, term } }, new Set(["CASE-1"])).get("CASE-1")?.term, term);
});

function baseCase(overrides: Partial<EvalCase> & Pick<EvalCase, "id">): EvalCase {
  return {
    category: "test", difficulty: "easy", source: "fixed",
    prompt: `评测用例 ${overrides.id}`,
    checks: [{ kind: "status", in: ["succeeded"] }],
    ...overrides,
  };
}

test("scripted：工具调用、业务事实与 trace 可观测", async () => {
  const target = new ScriptedTarget();
  await target.setup(options);
  try {
    const c = baseCase({
      id: "target-inbox-001",
      prompt: "请把这条通知保存到信息中心：CM评测讲座 11月23日14:00 图书馆101",
      script: [
        { toolCalls: [{ name: "save_to_inbox", arguments: { title: "CM评测讲座", rawText: "CM评测讲座 11月23日14:00 图书馆101", deadline: "2026-11-23" } }] },
        { content: "已保存到信息中心，只有一条记录。" },
      ],
    });
    const obs = await target.run(c, { timeoutMs: 20_000 });
    assert.equal(obs.status, "succeeded");
    assert.match(obs.reply, /已保存/);
    assert.equal(obs.toolCalls.length, 1);
    assert.equal(obs.toolCalls[0].name, "save_to_inbox");
    assert.equal(obs.toolCalls[0].ok, true);
    assert.equal(obs.business.inbox.length, 1);
    assert.equal(obs.business.inbox[0].title, "CM评测讲座");
    assert.ok(obs.trace.events.some((e) => e.type === "tool.called"));
    assert.ok(obs.trace.events.some((e) => e.type === "tool.result"));
    assert.ok(obs.trace.llm.rounds.length >= 2);
  } finally {
    await target.dispose();
  }
});

test("scripted：外部网络工具默认离线，未提供夹具必须失败而不是偷偷联网", async () => {
  const target = new ScriptedTarget();
  await target.setup(options);
  try {
    const c = baseCase({
      id: "target-offline-001",
      script: [{ toolCalls: [{ name: "web_search", arguments: { query: "2026 竞赛" } }] }, { content: "没有取得网络结果。" }],
    });
    const obs = await target.run(c, { timeoutMs: 20_000 });
    assert.equal(obs.toolCalls.length, 1);
    assert.equal(obs.toolCalls[0].ok, false);
    assert.match(obs.toolCalls[0].resultPreview, /离线评测禁止真实网络/);
  } finally {
    await target.dispose();
  }
});

test("scripted：夹具可注入工具失败，模型继续如实说明", async () => {
  const target = new ScriptedTarget();
  await target.setup(options);
  try {
    const c = baseCase({
      id: "target-recovery-001",
      script: [{ toolCalls: [{ name: "save_to_inbox", arguments: { title: "x", rawText: "y" } }] }, { content: "写入失败，已知悉，不再重复写入。" }],
      toolStubs: { save_to_inbox: { error: "duplicate key | code: 23505" } },
    });
    const obs = await target.run(c, { timeoutMs: 20_000 });
    assert.equal(obs.status, "succeeded");
    assert.equal(obs.toolCalls[0].ok, false);
    assert.match(obs.reply, /失败/);
    assert.equal(obs.business.inbox.length, 0);
  } finally {
    await target.dispose();
  }
});

test("scripted：传输失败标记 failed/mock，不伪造成功", async () => {
  const target = new ScriptedTarget();
  await target.setup(options);
  try {
    const c = baseCase({ id: "target-transport-001", script: [{ content: "x" }], simulate: { transportError: "HTTP 503: upstream down" } });
    const obs = await target.run(c, { timeoutMs: 20_000 });
    assert.equal(obs.status, "failed");
    assert.equal(obs.mock, true);
  } finally {
    await target.dispose();
  }
});

test("api-memory：HTTP+Worker 完整链路、JWT owner 隔离、事件与业务事实", async () => {
  const target = new ApiTarget("script");
  await target.setup({ ...options, concurrency: 1 });
  try {
    const c = baseCase({
      id: "target-api-001",
      prompt: "把 CM API 评测讲座保存到信息中心：11月24日19:00，线上。",
      script: [
        { toolCalls: [{ name: "save_to_inbox", arguments: { title: "CM API 评测讲座", rawText: "CM API 评测讲座 11月24日19:00 线上", deadline: "2026-11-24" } }] },
        { content: "已保存到信息中心。" },
      ],
    });
    const obs = await target.run(c, { timeoutMs: 30_000 });
    assert.equal(obs.status, "succeeded");
    assert.equal(obs.target, "api-memory");
    assert.equal(obs.business.inbox.length, 1);
    assert.equal(obs.business.inbox[0].title, "CM API 评测讲座");
    assert.ok(obs.trace.events.some((e) => e.type === "tool.result"));
    assert.ok(obs.trace.events.some((e) => e.type === "eval.passed"));
    assert.ok(obs.toolCalls.length >= 1);
    assert.match(obs.reply, /已保存/);
  } finally {
    await target.dispose();
  }
});

test("api-memory：高风险工具触发审批暂停（needs_input），不执行未批准写入", async () => {
  const target = new ApiTarget("script");
  await target.setup({ ...options, concurrency: 1 });
  try {
    const c = baseCase({
      id: "target-approval-001",
      prompt: "提交核验提案：CM评测比赛，官网 https://example.com/contest",
      script: [
        { toolCalls: [{ name: "propose_verification", arguments: { opportunityId: "opp-1", proposedStatus: "VERIFIED", summary: "来源为官网", evidence: [{ sourceUrl: "https://example.com/contest", excerpt: "报名截止 2026-12-01", supports: "截止时间", confidence: 0.8 }] } }] },
      ],
    });
    const obs = await target.run(c, { timeoutMs: 30_000 });
    assert.equal(obs.status, "needs_input");
    assert.equal(obs.business.pendingApprovals, 1);
    assert.equal(obs.business.opportunities.length, 0);
  } finally {
    await target.dispose();
  }
});
