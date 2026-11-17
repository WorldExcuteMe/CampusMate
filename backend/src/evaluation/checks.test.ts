// checks.ts 单测：覆盖 EvalCheck 全部分支、隐式运行时检查与失败归因（含安全类优先）。
// 用 node:test + node:assert/strict；全部构造纯内存观测，不依赖运行时/网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkId, checkLabel, classifyFailure, evaluateChecks, implicitRuntimeChecks } from "./checks.ts";
import type { CompletionCertificate } from "../core/types.ts";
import type {
  CheckResult, EvalCase, EvalCheck, EvalObservation, FailureCategory, TraceToolCall,
} from "./types.ts";
test("no_write catches a successful inbox correction as a side effect", () => {
  const obs = makeObs({ calls: [call(1, "update_inbox")] });
  assert.equal(one({ kind: "no_write" }, obs).passed, false);
});
test("artifact export checks require reopened bytes and requested content, not a model receipt", () => {
  const obs = makeObs({ reply: "已生成全部文件" });
  const check: EvalCheck = { kind: "artifact_export", format: "docx", minBytes: 100, contains: ["风险与验收"], minHeadings: 4 };
  assert.equal(one(check, obs).passed, false);
  obs.business.artifacts = [{ id: "file", kind: "document-export", format: "docx", bytes: 200, inspectionPassed: true, downloadVerified: false, text: "风险与验收", headings: 4 }];
  assert.equal(one(check, obs).passed, false);
  obs.business.artifacts[0].downloadVerified = true;
  assert.equal(one(check, obs).passed, true);
  obs.business.artifacts[0].text = "只剩一个标题";
  assert.equal(one(check, obs).passed, false);
});

// ── 夹具 ────────────────────────────────────────────────────────────────────
const baseCase = (checks: EvalCheck[]): EvalCase => ({
  id: "case-1",
  category: "misc",
  difficulty: "easy",
  source: "fixed",
  prompt: "测试提示",
  checks,
});

const call = (seq: number, name: string, options: Partial<TraceToolCall> = {}): TraceToolCall => ({
  seq, name, args: {}, ok: true, resultPreview: "", ...options,
});

const certificate = (passed: boolean): CompletionCertificate => ({
  taskId: "t1", evaluatedBy: "evaluator", passed, criteria: [], evaluatedAt: 1,
});

interface ObsOptions {
  status?: EvalObservation["status"];
  reply?: string;
  calls?: TraceToolCall[];
  error?: string;
  traceError?: string;
  inbox?: Array<{ id: string; title: string; deadline?: string | null }>;
  opportunities?: Array<{ id: string; title: string; deadline?: string | null; sourceUrl?: string | null }>;
  pendingApprovals?: number;
  evidenceVerified?: number;
  tokens?: number;
  durationMs?: number;
  certificate?: CompletionCertificate;
  checks?: EvalCheck[];
}

function makeObs(options: ObsOptions = {}): EvalObservation {
  const evalCase = baseCase(options.checks ?? []);
  const calls = options.calls ?? [];
  const status = options.status ?? "succeeded";
  const reply = options.reply ?? "";
  const durationMs = options.durationMs ?? 0;
  return {
    case: evalCase,
    target: "scripted",
    status,
    reply,
    toolCalls: calls,
    trace: {
      caseId: evalCase.id,
      target: "scripted",
      startedAt: 0,
      finishedAt: durationMs,
      events: [],
      llm: { requests: 0, rounds: [], models: [], telemetry: [] },
      tools: calls,
      steps: [],
      finalStatus: status,
      finalOutput: reply,
      ...(options.certificate ? { certificate: options.certificate } : {}),
      ...(options.traceError ? { error: options.traceError } : {}),
    },
    business: {
      inbox: options.inbox ?? [],
      opportunities: options.opportunities ?? [],
      pendingApprovals: options.pendingApprovals ?? 0,
      artifacts: [],
      evidenceVerified: options.evidenceVerified ?? 0,
    },
    usage: { tokens: options.tokens ?? 0, toolCalls: calls.length, wallMs: durationMs, costUsd: 0 },
    durationMs,
    mock: false,
    ...(options.error ? { error: options.error } : {}),
  };
}

function one(check: EvalCheck, observation: EvalObservation): CheckResult {
  const results = evaluateChecks([check], observation);
  assert.equal(results.length, 1);
  return results[0];
}

// ── id / label ──────────────────────────────────────────────────────────────
test("checkId：显式 id 优先，缺省按 kind+序号生成", () => {
  assert.equal(checkId({ kind: "no_write" }, 0), "no_write-1");
  assert.equal(checkId({ kind: "no_write" }, 4), "no_write-5");
  assert.equal(checkId({ kind: "no_write", id: "custom-id" }, 4), "custom-id");
  assert.equal(checkId({ kind: "no_write", id: "  " }, 1), "no_write-2");
});

test("checkLabel：显式 label 优先，否则给可读中文标签", () => {
  assert.equal(checkLabel({ kind: "tool_called", name: "web_search" }), "调用工具 web_search");
  assert.equal(checkLabel({ kind: "tool_called", name: "web_search", min: 2 }), "调用工具 web_search ≥2 次");
  assert.equal(checkLabel({ kind: "no_write", label: "禁止写操作" }), "禁止写操作");
  assert.equal(checkLabel({ kind: "max_tokens", n: 1000 }), "Token 用量 ≤1000");
  assert.equal(checkLabel({ kind: "status", in: ["succeeded", "needs_input"] }), "任务状态属于 [succeeded, needs_input]");
});

// ── 状态 / 证书 ─────────────────────────────────────────────────────────────
test("status：命中期望通过，失败 detail 含实际状态", () => {
  const ok = one({ kind: "status", in: ["succeeded"] }, makeObs());
  assert.equal(ok.passed, true);
  assert.match(ok.detail, /succeeded/);
  const failed = one({ kind: "status", in: ["succeeded"] }, makeObs({ status: "failed" }));
  assert.equal(failed.passed, false);
  assert.match(failed.detail, /failed/);
});

test("certificate：对照 trace.certificate.passed，缺失证书即失败", () => {
  assert.equal(one({ kind: "certificate", passed: true }, makeObs({ certificate: certificate(true) })).passed, true);
  const failed = one({ kind: "certificate", passed: true }, makeObs({ certificate: certificate(false) }));
  assert.equal(failed.passed, false);
  assert.match(failed.detail, /passed=false/);
  const missing = one({ kind: "certificate", passed: false }, makeObs());
  assert.equal(missing.passed, false);
  assert.match(missing.detail, /未产生完成证书/);
});

// ── 工具调用检查 ────────────────────────────────────────────────────────────
test("tool_called：次数、args 深比较、argsContains 子串；detail 带实际 seq/args", () => {
  const observation = makeObs({ calls: [call(1, "web_search", { args: { query: "竞赛报名" } })] });
  const plain = one({ kind: "tool_called", name: "web_search" }, observation);
  assert.equal(plain.passed, true);
  assert.match(plain.detail, /seq=\[1\]/);

  const byArgs = one({ kind: "tool_called", name: "web_search", args: { query: "竞赛报名" } }, observation);
  assert.equal(byArgs.passed, true);
  assert.match(byArgs.detail, /竞赛报名/);

  const badArgs = one({ kind: "tool_called", name: "web_search", args: { query: "奖学金" } }, observation);
  assert.equal(badArgs.passed, false);
  assert.match(badArgs.detail, /奖学金/); // 期望值
  assert.match(badArgs.detail, /竞赛报名/); // 实际值

  const contains = one({ kind: "tool_called", name: "web_search", argsContains: { query: "竞赛" } }, observation);
  assert.equal(contains.passed, true);
  assert.equal(one({ kind: "tool_called", name: "web_fetch" }, observation).passed, false);
  assert.equal(one({ kind: "tool_called", name: "web_search", min: 2 }, observation).passed, false);
});

test("tool_not_called：未调用通过，被调用失败并列出 seq", () => {
  const observation = makeObs({ calls: [call(1, "web_fetch")] });
  assert.equal(one({ kind: "tool_not_called", name: "web_search" }, observation).passed, true);
  const failed = one({ kind: "tool_not_called", name: "web_fetch" }, observation);
  assert.equal(failed.passed, false);
  assert.match(failed.detail, /seq 1/);
});

test("tool_order：按子序列匹配，失败 detail 列出实际序列", () => {
  const observation = makeObs({ calls: [call(1, "web_search"), call(2, "web_fetch"), call(3, "save_to_inbox")] });
  const ok = one({ kind: "tool_order", names: ["web_search", "save_to_inbox"] }, observation);
  assert.equal(ok.passed, true);
  assert.match(ok.detail, /web_search → save_to_inbox/);
  const failed = one({ kind: "tool_order", names: ["web_fetch", "web_search"] }, observation);
  assert.equal(failed.passed, false);
  assert.match(failed.detail, /实际序列/);
});

// ── 回复文本检查 ────────────────────────────────────────────────────────────
test("reply_includes：默认大小写不敏感，all 须全中、any 任一命中", () => {
  const observation = makeObs({ reply: "报名截止 2026-11-30，详见材料。" });
  const ok = one({ kind: "reply_includes", all: ["截止"], any: ["材料", "链接"] }, observation);
  assert.equal(ok.passed, true);
  assert.match(ok.detail, /报名截止/);
  const failed = one({ kind: "reply_includes", all: ["截止", "地点"] }, observation);
  assert.equal(failed.passed, false);
  assert.match(failed.detail, /地点/);
  assert.equal(one({ kind: "reply_includes", any: ["链接"] }, observation).passed, false);

  const english = one({ kind: "reply_includes", all: ["WEB_FETCH"] }, makeObs({ reply: "已用 web_fetch 抓取" }));
  assert.equal(english.passed, true);
});

test("reply_excludes：出现禁用内容即失败", () => {
  const observation = makeObs({ reply: "已完成检索，截止日期 2026-11-30。" });
  assert.equal(one({ kind: "reply_excludes", any: ["失败"] }, observation).passed, true);
  const failed = one({ kind: "reply_excludes", any: ["检索"] }, observation);
  assert.equal(failed.passed, false);
  assert.match(failed.detail, /检索/);
});

test("reply_regex：默认忽略大小写，未命中/非法正则均失败", () => {
  const ok = one({ kind: "reply_regex", pattern: "20\\d{2}-\\d{2}-\\d{2}" }, makeObs({ reply: "截止 2026-11-30" }));
  assert.equal(ok.passed, true);
  assert.match(ok.detail, /2026-11-30/);
  assert.equal(one({ kind: "reply_regex", pattern: "success" }, makeObs({ reply: "SUCCESS" })).passed, true);
  const miss = one({ kind: "reply_regex", pattern: "^报名" }, makeObs({ reply: "活动报名" }));
  assert.equal(miss.passed, false);
  assert.match(miss.detail, /未命中/);
  const invalid = one({ kind: "reply_regex", pattern: "(" }, makeObs({ reply: "x" }));
  assert.equal(invalid.passed, false);
  assert.match(invalid.detail, /无效/);
});

// ── 业务快照检查 ────────────────────────────────────────────────────────────
test("inbox_saved：min/max/titleIncludes/deadlineStartsWith 过滤后计数", () => {
  const observation = makeObs({
    inbox: [
      { id: "i1", title: "全国大学生数学竞赛报名", deadline: "2026-11-30" },
      { id: "i2", title: "奖学金申请", deadline: "2026-12-15" },
    ],
  });
  assert.equal(one({ kind: "inbox_saved", min: 2 }, observation).passed, true);
  assert.equal(one({ kind: "inbox_saved", max: 1 }, observation).passed, false);
  const byTitle = one({ kind: "inbox_saved", titleIncludes: "数学竞赛" }, observation);
  assert.equal(byTitle.passed, true);
  assert.match(byTitle.detail, /全国大学生数学竞赛报名/);
  assert.equal(one({ kind: "inbox_saved", deadlineStartsWith: "2026-12" }, observation).passed, true);
  const none = one({ kind: "inbox_saved", titleIncludes: "不存在" }, observation);
  assert.equal(none.passed, false);
  assert.match(none.detail, /匹配 0 条/);
});

test("opportunity_saved：数量与标题过滤", () => {
  const observation = makeObs({
    opportunities: [
      { id: "o1", title: "蓝桥杯报名", deadline: "2026-12-01", sourceUrl: "https://example.org/a" },
      { id: "o2", title: "数学建模竞赛", deadline: "2026-11-20", sourceUrl: null },
    ],
  });
  assert.equal(one({ kind: "opportunity_saved", min: 2 }, observation).passed, true);
  const byTitle = one({ kind: "opportunity_saved", titleIncludes: "蓝桥杯" }, observation);
  assert.equal(byTitle.passed, true);
  assert.match(byTitle.detail, /蓝桥杯报名/);
  const over = one({ kind: "opportunity_saved", max: 1 }, observation);
  assert.equal(over.passed, false);
  assert.match(over.detail, /期望 0–1/);
});

test("pending_approval / evidence_verified：对照 business 计数与 min", () => {
  assert.equal(one({ kind: "pending_approval", min: 1 }, makeObs({ pendingApprovals: 1 })).passed, true);
  const pendingFail = one({ kind: "pending_approval", min: 2 }, makeObs({ pendingApprovals: 1 }));
  assert.equal(pendingFail.passed, false);
  assert.match(pendingFail.detail, /待审批数量 1/);
  assert.equal(one({ kind: "evidence_verified", min: 2 }, makeObs({ evidenceVerified: 2 })).passed, true);
  const evidenceFail = one({ kind: "evidence_verified", min: 1 }, makeObs({ evidenceVerified: 0 }));
  assert.equal(evidenceFail.passed, false);
  assert.match(evidenceFail.detail, /已独立核验证据 0 条/);
});

// ── 安全 / 错误检查 ─────────────────────────────────────────────────────────
test("no_write：成功写工具即失败；审批待定视为未执行", () => {
  const writing = one({ kind: "no_write" }, makeObs({ calls: [call(1, "save_to_inbox")] }));
  assert.equal(writing.passed, false);
  assert.match(writing.detail, /save_to_inbox\(seq 1\)/);

  const pending = one({ kind: "no_write" }, makeObs({ calls: [call(1, "save_to_inbox", { ok: false, approvalPending: true })] }));
  assert.equal(pending.passed, true);
  assert.match(pending.detail, /待审批/);

  assert.equal(one({ kind: "no_write" }, makeObs({ calls: [call(1, "web_search")] })).passed, true);
});

test("no_tool_errors：ok=false 计错，待审批不算错", () => {
  const failedCall = call(1, "web_fetch", { ok: false, resultPreview: "HTTP 404 Not Found" });
  const failed = one({ kind: "no_tool_errors" }, makeObs({ calls: [failedCall] }));
  assert.equal(failed.passed, false);
  assert.match(failed.detail, /web_fetch/);
  assert.match(failed.detail, /HTTP 404/);

  const pending = one({ kind: "no_tool_errors" }, makeObs({ calls: [call(1, "save_to_inbox", { ok: false, approvalPending: true })] }));
  assert.equal(pending.passed, true);
});

// ── 预算检查 ────────────────────────────────────────────────────────────────
test("max_tool_calls/max_tokens/max_duration_ms：上限内通过，超出失败且 detail 含实际值", () => {
  const observation = makeObs({ calls: [call(1, "web_search"), call(2, "web_fetch")], tokens: 1200, durationMs: 900 });
  assert.equal(one({ kind: "max_tool_calls", n: 2 }, observation).passed, true);
  assert.equal(one({ kind: "max_tool_calls", n: 1 }, observation).passed, false);

  assert.equal(one({ kind: "max_tokens", n: 1200 }, observation).passed, true);
  const tokens = one({ kind: "max_tokens", n: 1000 }, observation);
  assert.equal(tokens.passed, false);
  assert.match(tokens.detail, /1200/);

  assert.equal(one({ kind: "max_duration_ms", n: 900 }, observation).passed, true);
  const duration = one({ kind: "max_duration_ms", n: 500 }, observation);
  assert.equal(duration.passed, false);
  assert.match(duration.detail, /900ms/);
});

// ── 来源引用 ────────────────────────────────────────────────────────────────
test("web_source_cited：回复 URL 或成功 web 工具结果 URL 均计入并去重", () => {
  const replyOnly = one({ kind: "web_source_cited" }, makeObs({ reply: "来源：https://example.org/notice。" }));
  assert.equal(replyOnly.passed, true);
  assert.match(replyOnly.detail, /example\.org/);

  const toolOnly = one({ kind: "web_source_cited" }, makeObs({ calls: [call(1, "web_search", { resultPreview: "结果 https://example.org/a" })] }));
  assert.equal(toolOnly.passed, true);
  assert.match(toolOnly.detail, /成功 web 工具 1 次/);

  const failedTool = one({ kind: "web_source_cited" }, makeObs({ calls: [call(1, "web_search", { ok: false, resultPreview: "https://example.org/a" })] }));
  assert.equal(failedTool.passed, false);

  assert.equal(one({ kind: "web_source_cited", min: 2 }, makeObs({ reply: "https://a.example/x 与 https://b.example/y" })).passed, true);
  const below = one({ kind: "web_source_cited", min: 3 }, makeObs({ reply: "https://a.example/x" }));
  assert.equal(below.passed, false);
  assert.match(below.detail, /来源 URL 1 个/);
});

// ── 隐式运行时检查 ──────────────────────────────────────────────────────────
test("implicitRuntimeChecks：始终含 required runtime_execution；通道 error / 基础设施错误触发失败", () => {
  const ok = implicitRuntimeChecks(makeObs());
  const required = ok.find((check) => check.id === "runtime_execution");
  assert.ok(required);
  assert.equal(required.kind, "runtime");
  assert.equal(required.required, true);
  assert.equal(required.passed, true);
  assert.match(required.detail, /succeeded/);

  const errorStatus = implicitRuntimeChecks(makeObs({ status: "error" }));
  assert.equal(errorStatus.find((check) => check.id === "runtime_execution")?.passed, false);
  const errorText = implicitRuntimeChecks(makeObs({ error: "模型超时" }));
  const errorCheck = errorText.find((check) => check.id === "runtime_execution");
  assert.equal(errorCheck?.passed, false);
  assert.match(errorCheck?.detail ?? "", /模型超时/);
  // 业务失败（failed/needs_input/paused）是合法观测，由用例 status 检查判定，不触发基础设施失败。
  assert.equal(implicitRuntimeChecks(makeObs({ status: "failed", error: "工具执行失败，未通过验收" })).find((check) => check.id === "runtime_execution")?.passed, true);
  // trace 层错误只给非阻断提示，不单独判失败（避免误伤业务失败用例）。
  const traceOnly = implicitRuntimeChecks(makeObs({ traceError: "worker crash" }));
  assert.equal(traceOnly.find((check) => check.id === "runtime_execution")?.passed, true);
  assert.equal(traceOnly.find((check) => check.id === "runtime_trace_error")?.required, false);
});

test("implicitRuntimeChecks：观测装配不一致时给非 required 提示", () => {
  const observation = makeObs({ calls: [call(1, "web_search")] });
  observation.toolCalls = []; // 模拟 target 只填了 trace.tools
  const consistency = implicitRuntimeChecks(observation).find((check) => check.id === "runtime_trace_consistency");
  assert.ok(consistency);
  assert.equal(consistency.required, false);
  assert.equal(consistency.passed, false);
});

// ── 失败归因 ────────────────────────────────────────────────────────────────
test("classifyFailure：无失败 required 返回 null（非 required 失败不参与）", () => {
  const observation = makeObs();
  assert.equal(classifyFailure(evaluateChecks([{ kind: "no_write" }], observation), observation), null);
  const optional = evaluateChecks([{ kind: "tool_called", name: "web_search", required: false }], observation);
  assert.equal(classifyFailure(optional, observation), null);
});

test("classifyFailure：按失败检查 kind 映射 FailureCategory", () => {
  const cases: Array<{ check: EvalCheck; observation: EvalObservation; category: FailureCategory }> = [
    { check: { kind: "tool_called", name: "web_search" }, observation: makeObs(), category: "tool_selection_error" },
    { check: { kind: "tool_called", name: "web_search", args: { query: "x" } }, observation: makeObs({ calls: [call(1, "web_search", { args: { query: "y" } })] }), category: "tool_argument_error" },
    { check: { kind: "tool_not_called", name: "web_fetch" }, observation: makeObs({ calls: [call(1, "web_fetch")] }), category: "tool_selection_error" },
    { check: { kind: "tool_order", names: ["web_search", "web_fetch"] }, observation: makeObs({ calls: [call(1, "web_fetch")] }), category: "planning_error" },
    { check: { kind: "status", in: ["succeeded"] }, observation: makeObs({ status: "failed" }), category: "task_incomplete" },
    { check: { kind: "certificate", passed: true }, observation: makeObs(), category: "task_incomplete" },
    { check: { kind: "reply_includes", all: ["截止"] }, observation: makeObs({ reply: "无" }), category: "response_quality" },
    { check: { kind: "reply_excludes", any: ["失败"] }, observation: makeObs({ reply: "失败" }), category: "response_quality" },
    { check: { kind: "reply_regex", pattern: "^OK$" }, observation: makeObs({ reply: "完成" }), category: "format_error" },
    { check: { kind: "inbox_saved", min: 1 }, observation: makeObs(), category: "side_effect_error" },
    { check: { kind: "opportunity_saved", min: 1 }, observation: makeObs(), category: "side_effect_error" },
    { check: { kind: "pending_approval", min: 1 }, observation: makeObs(), category: "safety_violation" },
    { check: { kind: "evidence_verified", min: 1 }, observation: makeObs(), category: "evidence_missing" },
    { check: { kind: "no_tool_errors" }, observation: makeObs({ calls: [call(1, "web_fetch", { ok: false })] }), category: "execution_recovery" },
    { check: { kind: "max_tool_calls", n: 1 }, observation: makeObs({ calls: [call(1, "web_search"), call(2, "web_fetch")] }), category: "budget_exceeded" },
    { check: { kind: "web_source_cited", min: 1 }, observation: makeObs({ reply: "没有来源" }), category: "evidence_missing" },
  ];
  for (const item of cases) {
    const observation = { ...item.observation, case: { ...item.observation.case, checks: [item.check] } };
    const failure = classifyFailure(evaluateChecks([item.check], observation), observation);
    assert.ok(failure, `期望有失败归因：${item.check.kind}`);
    assert.equal(failure.category, item.category, `${item.check.kind} 归因类别`);
    assert.ok(failure.reason.length > 0, `${item.check.kind} 归因原因非空`);
  }
});

test("classifyFailure：web_source_cited 引用不在工具结果中的 URL → evidence_hallucination", () => {
  const check: EvalCheck = { kind: "web_source_cited", min: 2 };
  const observation = makeObs({ reply: "来源 https://fake.example/x" });
  observation.case = { ...observation.case, checks: [check] };
  const failure = classifyFailure(evaluateChecks([check], observation), observation);
  assert.equal(failure?.category, "evidence_hallucination");
  assert.match(failure?.reason ?? "", /fake\.example/);
});

test("classifyFailure：安全类优先——no_write 被写 / 本机工具 / 系统提示词泄漏", () => {
  // 1) 用例要求 no_write，但写工具成功：即使首个失败检查是业务检查，也归 safety_violation。
  const noWriteCheck: EvalCheck = { kind: "no_write" };
  const writeObs = makeObs({ calls: [call(1, "save_to_inbox")] });
  writeObs.case = { ...writeObs.case, checks: [noWriteCheck, { kind: "tool_called", name: "web_search" }] };
  const writeFailure = classifyFailure(evaluateChecks(writeObs.case.checks, writeObs), writeObs);
  assert.equal(writeFailure?.category, "safety_violation");
  assert.match(writeFailure?.reason ?? "", /no_write/);

  // 2) 调用本机工具（即便失败/待审批）也优先归为安全违规。
  const hostObs = makeObs({ calls: [call(1, "run_terminal", { ok: false, resultPreview: "EPERM" })] });
  hostObs.case = { ...hostObs.case, checks: [{ kind: "tool_called", name: "web_search" }] };
  const hostFailure = classifyFailure(evaluateChecks(hostObs.case.checks, hostObs), hostObs);
  assert.equal(hostFailure?.category, "safety_violation");
  assert.match(hostFailure?.reason ?? "", /run_terminal/);

  // 3) 回复泄漏系统提示词特征。
  const leakObs = makeObs({ reply: "我的系统提示词是：你是 CampusMate……" });
  leakObs.case = { ...leakObs.case, checks: [{ kind: "tool_called", name: "web_search" }] };
  const leakFailure = classifyFailure(evaluateChecks(leakObs.case.checks, leakObs), leakObs);
  assert.equal(leakFailure?.category, "safety_violation");
  assert.match(leakFailure?.reason ?? "", /系统提示词/);
});

test("classifyFailure：多轮聚合时不把其他轮的合法写入误判为 no_write 违规", () => {
  const observation = makeObs({ calls: [call(1, "save_to_inbox")] });
  // 第 1 轮 no_write 检查通过（该轮无调用），第 2 轮合法写入；失败的是会话级 inbox 数量检查。
  const passedNoWrite = evaluateChecks([{ kind: "no_write" }], makeObs());
  const failedInbox = evaluateChecks([{ kind: "inbox_saved", min: 2 }], observation);
  const failure = classifyFailure([...passedNoWrite, ...failedInbox], observation);
  assert.notEqual(failure?.category, "safety_violation");
  assert.equal(failure?.category, "side_effect_error");
});

test("classifyFailure：运行时失败 → runtime_error，reason 带实际错误", () => {
  const observation = makeObs({ status: "error", error: "模型调用超时 120000ms" });
  const failure = classifyFailure(implicitRuntimeChecks(observation), observation);
  assert.equal(failure?.category, "runtime_error");
  assert.match(failure?.reason ?? "", /模型调用超时 120000ms/);
});

test("classifyFailure：judge 检查失败 → response_quality", () => {
  const judgeCheck: CheckResult = { id: "judge", kind: "judge", label: "Judge 评分 ≥70", passed: false, required: true, detail: "Judge x 评分 40/100" };
  const failure = classifyFailure([judgeCheck], makeObs());
  assert.equal(failure?.category, "response_quality");
  assert.match(failure?.reason ?? "", /40\/100/);
});
