// Runner 调度自测：并发、通道过滤、超时兜底、指标口径与产物落盘。
// 用假 Target 注入行为，避免依赖真实模型/网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { computeMetrics, runEvaluation } from "./runner.ts";
test("timeout remains a failure while retaining a cooperatively cancelled target's earlier trace", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"cm-eval-timeout-trace-"));
  const helper=new FakeTarget(async c=>observation(c));
  const target: EvalTarget={kind:"scripted",setup:o=>helper.setup(o),dispose:()=>helper.dispose(),describe:()=>helper.describe(),run:(c,options)=>new Promise(resolve=>{
    options.signal!.addEventListener("abort",()=>{const obs=observation(c,"cancelled","先前草稿已保留");obs.trace.events=[{seq:1,type:"checkpoint.written",payload:{stage:"earlier-step"},at:1}];resolve(obs);},{once:true});
  })};
  const out=await runEvaluation({suites:[suite("timeout-retain",[makeCase({id:"KEEP-TRACE"})])],target,concurrency:1,timeoutMs:10,offlineTools:true,runsRoot:root});
  assert.equal(out.run.results[0].passed,false); assert.equal(out.run.results[0].status,"error");
  const trace=JSON.parse(fs.readFileSync(out.run.results[0].tracePath!,"utf8"));
  assert.equal(trace.events[0]?.payload.stage,"earlier-step");
});
import type {
  EvalCase, EvalObservation, EvalResult, EvalRun, EvalSuite, EvalTarget, TargetDescription, TargetOptions, TraceToolCall,
} from "./types.ts";

function makeCase(overrides: Partial<EvalCase> & Pick<EvalCase, "id">): EvalCase {
  return { category: "test", difficulty: "easy", source: "fixed", prompt: `p-${overrides.id}`, checks: [{ kind: "status", in: ["succeeded"] }], ...overrides };
}

function observation(c: EvalCase, status: EvalObservation["status"] = "succeeded", reply = "完成"): EvalObservation {
  const tools: TraceToolCall[] = [];
  return {
    case: c, target: "scripted", status, reply, toolCalls: tools,
    trace: {
      caseId: c.id, target: "scripted", startedAt: 0, finishedAt: 1, events: [],
      llm: { requests: 1, rounds: [{ round: 1, toolCalls: 0 }], models: ["fake"], telemetry: [] },
      tools, steps: [], finalStatus: status, finalOutput: reply,
    },
    business: { inbox: [], opportunities: [], pendingApprovals: 0, artifacts: [], evidenceVerified: 0 },
    usage: { tokens: 10, toolCalls: 0, wallMs: 1, costUsd: 0 },
    durationMs: 1, mock: false,
  };
}

class FakeTarget implements EvalTarget {
  readonly kind = "scripted" as const;
  private readonly behavior: (c: EvalCase) => Promise<EvalObservation>;
  disposed = false;
  constructor(behavior: (c: EvalCase) => Promise<EvalObservation>) { this.behavior = behavior; }
  async setup(_options: TargetOptions): Promise<void> { /* no-op */ }
  async run(c: EvalCase): Promise<EvalObservation> { return this.behavior(c); }
  async dispose(): Promise<void> { this.disposed = true; }
  describe(): TargetDescription {
    return { kind: "scripted", label: "fake", realModel: false, durableStore: false, networkTools: false, supportsBusinessFacts: false, notes: [] };
  }
}

function suite(id: string, cases: EvalCase[]): EvalSuite {
  return { schemaVersion: 1, id, name: id, cases };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "campusmate-eval-runner-"));
}

test("runner：调度、指标口径（skipped/exploratory 不计分）与产物落盘", async () => {
  const root = await tempRoot();
  const cases = [
    makeCase({ id: "R-001" }),
    makeCase({ id: "R-002" }),
    makeCase({ id: "R-003", exploratory: true }),
    makeCase({ id: "R-004", tiers: ["live"] }),
  ];
  const target = new FakeTarget(async (c) => observation(c, c.id === "R-002" ? "failed" : "succeeded"));
  const output = await runEvaluation({
    suites: [suite("runner-suite", cases)], target, concurrency: 2, timeoutMs: 5000,
    offlineTools: true, label: "runner-test", runsRoot: root,
  });
  const run = output.run;
  assert.equal(run.metrics.total, 4);
  assert.equal(run.metrics.skipped, 1);
  assert.equal(run.metrics.exploratory, 1);
  assert.equal(run.metrics.passed, 1);
  assert.equal(run.metrics.failed, 1);
  assert.equal(run.metrics.passRate, 0.5);
  assert.deepEqual(run.metrics.byCategory.test, { total: 2, passed: 1, failed: 1, skipped: 0, passRate: 0.5 });
  assert.equal(run.metrics.failureCategories.task_incomplete, 1);
  assert.ok(target.disposed, "target 必须被 dispose");
  for (const file of ["manifest.json", "results.json", "report.md", "summary.json"]) {
    assert.ok(fs.existsSync(path.join(output.dir, file)), `缺少产物 ${file}`);
  }
  assert.ok(output.summary.failures.some((failure) => failure.caseId === "R-002"));
});

test("runner：超时兜底产生 error 观测，不会卡死整个批次", async () => {
  const root = await tempRoot();
  const target = new FakeTarget(async (c) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return observation(c);
  });
  const output = await runEvaluation({
    suites: [suite("runner-timeout", [makeCase({ id: "R-T1" })])], target,
    concurrency: 1, timeoutMs: 50, offlineTools: true, runsRoot: root,
  });
  const result = output.run.results[0];
  assert.equal(result.status, "error");
  assert.equal(result.passed, false);
  assert.equal(result.failureCategory, "runtime_error");
  assert.match(result.failureReason ?? "", /超时/);
  assert.ok(output.summary.failures[0].failedChecks.some((name) => /运行时执行/.test(name)));
});

test("runner：执行通道抛错降级为 runtime_error，不污染其它用例", async () => {
  const root = await tempRoot();
  const target = new FakeTarget(async (c) => {
    if (c.id === "R-E1") throw new Error("通道崩溃");
    return observation(c);
  });
  const output = await runEvaluation({
    suites: [suite("runner-throw", [makeCase({ id: "R-E1" }), makeCase({ id: "R-E2" })])], target,
    concurrency: 2, timeoutMs: 5000, offlineTools: true, runsRoot: root,
  });
  const first = output.run.results.find((result) => result.caseId === "R-E1");
  const second = output.run.results.find((result) => result.caseId === "R-E2");
  assert.equal(first?.status, "error");
  assert.equal(first?.failureCategory, "runtime_error");
  assert.equal(second?.passed, true);
});

test("computeMetrics：exploratory 失败不进入失败簇与硬门槛", () => {
  const results: EvalResult[] = [
    { caseId: "A", category: "security", difficulty: "easy", source: "fixed", target: "live", status: "succeeded", passed: true, checks: [], durationMs: 1, usage: { tokens: 1, toolCalls: 0, costUsd: 0 }, replyPreview: "", toolSequence: [] },
    { caseId: "B", category: "security", difficulty: "easy", source: "fixed", target: "live", status: "failed", passed: false, exploratory: true, failureCategory: "safety_violation", checks: [], durationMs: 1, usage: { tokens: 1, toolCalls: 0, costUsd: 0 }, replyPreview: "", toolSequence: [] },
    { caseId: "C", category: "planning", difficulty: "easy", source: "fixed", target: "live", status: "skipped", passed: false, checks: [], durationMs: 0, usage: { tokens: 0, toolCalls: 0, costUsd: 0 }, replyPreview: "", toolSequence: [] },
  ];
  const metrics = computeMetrics(results);
  assert.equal(metrics.passRate, 1);
  assert.equal(metrics.failureCategories.safety_violation, undefined);
  assert.deepEqual(metrics.hardGateViolations, []);
});

// 防止误报：run 结构必需字段存在（供 store/report/gate 复用）。
test("runner：run 结构包含 manifest/指标/时间戳", async () => {
  const root = await tempRoot();
  const target = new FakeTarget(async (c) => observation(c));
  const { run } = await runEvaluation({
    suites: [suite("runner-shape", [makeCase({ id: "R-S1" })])], target,
    concurrency: 1, timeoutMs: 5000, offlineTools: true, runsRoot: root,
  });
  const typed: EvalRun = run;
  assert.equal(typed.schemaVersion, 1);
  assert.ok(typed.startedAt && typed.finishedAt);
  assert.equal(typed.manifest.target, "scripted");
  assert.ok(typed.manifest.toolsHash.length > 0);
  assert.ok(Object.keys(typed.manifest.datasetHashes).includes("runner-shape"));
});
