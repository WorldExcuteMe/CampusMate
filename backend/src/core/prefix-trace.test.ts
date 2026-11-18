// 前缀缓存观测（Phase 1）与 CM_PREFIX_POLICY（Phase 2）测试。
// 覆盖：分段指纹、1024 块可缓存估算、失效段分类、职责域隔离、无提示词正文泄漏、
// 默认关闭时请求体字节不变，以及显式开启后的尾稳定合并与思考档位锁定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_BLOCK_TOKENS, PrefixTracer, PREFIX_TRACE_VERSION, type PrefixTelemetry, type PrefixTrace } from "./prefix-trace.ts";
import { COMPACTION_SUMMARY_MARKER } from "./context.ts";
import { DeepSeekTransport } from "./llm.ts";
import { runAgentLoop } from "./agent-loop.ts";
import { DEFAULT_BUDGET, type ChatMessage, type ToolDef } from "./types.ts";

const sys = (content: string): ChatMessage => ({ role: "system", content });
const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });
const toolMessage = (content: string, id = "call-1"): ChatMessage => ({ role: "tool", content, tool_call_id: id });
const tool = (name: string): ToolDef => ({ type: "function", function: { name, description: name, parameters: {} } });

function request(tracer: PrefixTracer, overrides: Partial<Parameters<PrefixTracer["record"]>[0]> = {}): PrefixTrace {
  return tracer.record({
    requestId: `req-${Math.random().toString(16).slice(2)}`,
    messages: [sys("rules"), user("hi")],
    systemEnd: 1,
    tools: [tool("a")],
    toolPlacement: "body",
    effort: { requested: "auto", effective: "low", family: "unknown", stage: "simple" },
    effortLocked: false,
    bodyChars: 123,
    bodyTokens: 45,
    ...overrides,
  });
}

function capturingFetch(usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 5 }) {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ model: "fixture-model", choices: [{ message: { content: "完成" }, finish_reason: "stop" }], usage }));
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

function traceOf(result: { telemetry?: unknown }): PrefixTrace {
  const trace = (result.telemetry as PrefixTelemetry | undefined)?.prefixTrace;
  assert.ok(trace, "telemetry.prefixTrace 必须存在");
  return trace;
}

test("分段指纹：段 A/B 稳定、段 C 边界链、扩展请求只追加尾部", () => {
  const tracer = new PrefixTracer({ baseUrl: "https://api.example", model: "fixture-model", policy: false });
  const first = request(tracer);
  tracer.commit();
  assert.equal(first.version, PREFIX_TRACE_VERSION);
  assert.equal(first.requestSeq, 0);
  assert.equal(first.cache.blockTokens, CACHE_BLOCK_TOKENS);
  assert.equal(first.system.hash.length, 64);
  assert.equal(first.system.count, 1);
  assert.equal(first.history.boundaries.length, 1);
  assert.equal(first.history.boundaries[0].role, "user");
  assert.equal(first.history.firstDivergence.kind, "initial");
  assert.equal(first.cache.basis, "no-baseline");
  assert.equal(first.cache.expectedCacheableTokens, 0);
  assert.equal(first.cache.changeKind, "initial");
  assert.equal(first.policy.enabled, false);
  assert.equal(first.policy.mode, "observe-only");

  const second = request(tracer, { messages: [sys("rules"), user("hi"), user("second")] });
  tracer.commit();
  assert.equal(second.requestSeq, 1);
  assert.equal(second.system.hash, first.system.hash);
  assert.equal(second.tools.hash, first.tools.hash);
  assert.equal(second.history.firstDivergence.kind, "extended");
  assert.equal(second.history.firstDivergence.index, 1);
  assert.equal(second.history.firstDivergence.previousRequestId, first.requestId);
  assert.equal(second.cache.prefixInvalidatingChange, false);
  assert.deepEqual(second.cache.changedSegments, []);
  assert.equal(second.cache.changeKind, "tail-only");
  // 命中部分 = 稳定前缀 + 与上一请求一致的历史前缀；再按 1024 块向下取整。
  const matched = second.cache.stablePrefixTokens + second.history.boundaries[0].tokens;
  assert.equal(second.cache.matchedHistoryMessages, 1);
  assert.equal(second.cache.expectedCacheableTokens, Math.floor(matched / CACHE_BLOCK_TOKENS) * CACHE_BLOCK_TOKENS);
});

test("系统提示词：中段改写整段失效，末尾追加保留旧前缀块", () => {
  const big = "x".repeat(6000); // ~1500 tokens，覆盖一个以上 1024 块
  const middle = new PrefixTracer({ baseUrl: "u", model: "m", policy: false });
  request(middle, { messages: [sys(big), user("hi")] });
  middle.commit();
  const changed = request(middle, { messages: [sys("y".repeat(3000) + big.slice(3000)), user("hi")] });
  assert.equal(changed.system.change, "middle");
  assert.equal(changed.cache.prefixInvalidatingChange, true);
  assert.deepEqual(changed.cache.changedSegments, ["system"]);
  assert.equal(changed.cache.changedSegment, "system");
  assert.equal(changed.cache.expectedCacheableTokens, 0);

  const appended = new PrefixTracer({ baseUrl: "u", model: "m", policy: false });
  const before = request(appended, { messages: [sys(big), user("hi")] });
  appended.commit();
  const after = request(appended, { messages: [sys(big + "-追加"), user("hi")] });
  assert.equal(after.system.change, "appended");
  assert.equal(after.cache.prefixInvalidatingChange, false);
  assert.deepEqual(after.cache.changedSegments, []);
  assert.equal(after.cache.changeKind, "prefix-append");
  assert.ok(before.cache.coldPrefixBlockTokens >= CACHE_BLOCK_TOKENS);
  assert.equal(after.cache.expectedCacheableTokens, Math.floor(before.cache.coldPrefixTokens / CACHE_BLOCK_TOKENS) * CACHE_BLOCK_TOKENS);
});

test("工具集或思考档位变化被标记为前缀失效，并给出变更点", () => {
  const tools = new PrefixTracer({ baseUrl: "u", model: "m", policy: false });
  request(tools, { tools: [tool("a"), tool("b")] });
  tools.commit();
  const changed = request(tools, { tools: [tool("b"), tool("c")] });
  assert.equal(changed.tools.changed, true);
  assert.deepEqual(changed.tools.added, ["c"]);
  assert.deepEqual(changed.tools.removed, ["a"]);
  assert.deepEqual(changed.cache.changedSegments, ["tools"]);
  assert.equal(changed.cache.expectedCacheableTokens, 0);

  const effort = new PrefixTracer({ baseUrl: "u", model: "m", policy: false });
  request(effort);
  effort.commit();
  const switched = request(effort, { effort: { requested: "auto", effective: "high", family: "deepseek_thinking", stage: "plan" } });
  assert.equal(switched.effort.changed, true);
  assert.equal(switched.effort.previous?.effective, "low");
  assert.equal(switched.effort.preambleExpected, true);
  assert.deepEqual(switched.cache.changedSegments, ["effort"]);
  assert.equal(switched.cache.expectedCacheableTokens, 0);
});

test("压缩摘要段 D 与尾部动态观测段 E 可区分", () => {
  const tracer = new PrefixTracer({ baseUrl: "u", model: "m", policy: true });
  const messages = [
    sys("rules"),
    user("q"),
    sys(COMPACTION_SUMMARY_MARKER + " 3 组早期轮次，保留要点】\n[x] y"),
    user("next"),
    sys("【研究交付进度】 继续"),
    user("[系统提醒] 工具已重复调用"),
    toolMessage("{}"),
  ];
  const trace = request(tracer, { messages, systemEnd: 1, tools: [], toolPlacement: "none" });
  assert.equal(trace.compaction.count, 1);
  assert.deepEqual(trace.compaction.indices, [2]);
  assert.equal(trace.dynamicTail.count, 3);
  assert.deepEqual(trace.dynamicTail.indices, [4, 5, 6]);
  assert.deepEqual(trace.dynamicTail.roles, ["system", "user", "tool"]);
  assert.equal(trace.system.hoisted, 0);
  assert.equal(trace.policy.enabled, true);
  assert.equal(trace.policy.mode, "tail-stable");
  assert.equal(trace.policy.toolPruning, "disabled");
  assert.ok(trace.policy.notes.includes("scope-incomplete"));
});

test("作用域：只暴露哈希，显式用户/工作区使 complete=true，基线不跨 tracer 复用", () => {
  const first = new PrefixTracer({ baseUrl: "u", model: "m", policy: false, scope: { userId: "user-secret-1", workspaceId: "workspace-secret-2" } });
  const second = new PrefixTracer({ baseUrl: "u", model: "m", policy: false, scope: { userId: "user-other-3", workspaceId: "workspace-secret-2" } });
  const a = request(first);
  first.commit();
  const b = request(second);
  assert.equal(a.scope.source, "explicit");
  assert.equal(a.scope.complete, true);
  assert.equal(a.scope.userIdHash?.length, 16);
  assert.equal(a.scope.workspaceHash?.length, 16);
  assert.notEqual(a.scope.id, b.scope.id);
  assert.notEqual(a.scope.userIdHash, b.scope.userIdHash);
  assert.equal(b.scope.workspaceHash, a.scope.workspaceHash);
  const json = JSON.stringify(a);
  for (const secret of ["user-secret-1", "workspace-secret-2"]) assert.ok(!json.includes(secret));
  // 每个 tracer 自带基线：第二个 tracer 的首个请求仍是 initial，不复用别人的缓存形状。
  assert.equal(b.history.firstDivergence.kind, "initial");
  assert.equal(b.cache.basis, "no-baseline");
});

test("事件只含哈希/长度/角色，绝不含提示词正文", () => {
  const tracer = new PrefixTracer({ baseUrl: "u", model: "m", policy: false });
  const secretSystem = "TOP-SECRET-SYSTEM-RULES-9f3a";
  const secretUser = "SECRET-USER-MESSAGE-7c2b";
  const secretToolResult = "SECRET-TOOL-RESULT-11aa";
  const trace = request(tracer, {
    messages: [sys(secretSystem), user(secretUser), assistant("SECRET-ASSISTANT-REPLY"), toolMessage(secretToolResult)],
    systemEnd: 1,
  });
  const json = JSON.stringify(trace);
  for (const secret of [secretSystem, secretUser, secretToolResult, "SECRET-ASSISTANT-REPLY"]) {
    assert.equal(json.includes(secret), false, `trace 泄漏了提示词正文片段: ${secret}`);
  }
  assert.ok(trace.history.boundaries.every((boundary) => typeof boundary.role === "string" && boundary.hash.length === 64));
  assert.ok(trace.total.chars > 0 && trace.total.tokens > 0);
  assert.ok(trace.overhead.hashedChars > 0);
  assert.ok(trace.overhead.hashCalls >= trace.history.boundaries.length + 2);
  assert.ok(Number.isFinite(trace.overhead.elapsedMs) && trace.overhead.elapsedMs >= 0);
});

test("transport：默认关闭时请求体字节确定、telemetry 携带 prefixTrace 与实际缓存观测", async () => {
  const first = capturingFetch({ prompt_tokens: 1226, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 1024 } });
  const second = capturingFetch({ prompt_tokens: 1226, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 1024 } });
  const messages = [sys("固定规则"), user("测试")];
  const tools = [tool("b"), tool("a")];
  const cfg = { apiKey: "fixture", capabilities: { tools: "native" }, fetchImpl: first.fetchImpl };
  const left = new DeepSeekTransport(cfg);
  const right = new DeepSeekTransport({ ...cfg, fetchImpl: second.fetchImpl });
  const result = await left.chat({ messages, tools });
  await right.chat({ messages, tools });
  // 观测模块不得改变请求体：相同配置/消息的两个 transport 发出完全相同的字节。
  assert.deepEqual(first.bodies[0], second.bodies[0]);
  assert.equal(result.content, "完成");
  const trace = traceOf(result);
  assert.equal(trace.version, PREFIX_TRACE_VERSION);
  assert.equal(trace.tools.placement, "body");
  assert.deepEqual(trace.effort.previous, null);
  assert.equal(trace.observed?.cachedTokens, 1024);
  assert.equal(trace.observed?.inputTokens, 1226);
  assert.equal(trace.cache.prefixInvalidatingChange, false);
  assert.equal(trace.cache.basis, "no-baseline");
  assert.equal(trace.cache.coldPrefixBlockTokens, Math.floor(trace.cache.coldPrefixTokens / 1024) * 1024);
});

test("transport：多轮请求报告首处历史差异位置与可复用块估算", async () => {
  const captured = capturingFetch();
  const transport = new DeepSeekTransport({ apiKey: "fixture", capabilities: { tools: "native" }, fetchImpl: captured.fetchImpl });
  const base: ChatMessage[] = [sys("规则"), user("第一轮问题")];
  const first = await transport.chat({ messages: base, tools: [] });
  const firstTrace = traceOf(first);
  const second = await transport.chat({
    messages: [...base, assistant("第一轮回答"), user("第二轮问题")],
    tools: [],
  });
  const secondTrace = traceOf(second);
  assert.equal(secondTrace.history.firstDivergence.kind, "extended");
  assert.equal(secondTrace.history.firstDivergence.index, firstTrace.history.boundaries.length);
  assert.equal(secondTrace.history.firstDivergence.previousRequestId, firstTrace.requestId);
  assert.equal(secondTrace.cache.changeKind, "tail-only");
  assert.equal(secondTrace.cache.matchedHistoryMessages, 1);
  assert.equal(
    secondTrace.cache.expectedCacheableTokens,
    Math.floor((secondTrace.cache.stablePrefixTokens + secondTrace.history.boundaries[0].tokens) / 1024) * 1024,
  );
});

test("transport：Phase 2 默认关闭而显式开启；开启后尾部 system 观测不再被提升到历史之前", async () => {
  const makeMessages = (): ChatMessage[] => [sys("固定规则"), sys("任务状态"), user("hi"), sys("【研究交付进度】 尾部提示"), user("next")];
  const tools = [tool("a")];
  const off = capturingFetch();
  const offTransport = new DeepSeekTransport({ apiKey: "fixture", capabilities: { tools: "json" }, fetchImpl: off.fetchImpl });
  const offResult = await offTransport.chat({ messages: makeMessages(), tools });
  // 旧行为保持不变：所有 system 合并进头部，尾注入被提升到历史之前。
  const offMessages = off.bodies[0].messages as ChatMessage[];
  assert.equal(offMessages.filter((message) => message.role === "system").length, 1);
  assert.match(String(offMessages[0].content), /研究交付进度/);
  const offTrace = traceOf(offResult);
  assert.equal(offTrace.policy.enabled, false);
  assert.equal(offTrace.system.hoisted, 1);
  assert.equal(offTrace.cache.prefixInvalidatingChange, false); // 首个请求，无基线

  const on = capturingFetch();
  const onTransport = new DeepSeekTransport({ apiKey: "fixture", capabilities: { tools: "json" }, prefixPolicy: true, fetchImpl: on.fetchImpl });
  const onResult = await onTransport.chat({ messages: makeMessages(), tools });
  const onMessages = on.bodies[0].messages as ChatMessage[];
  assert.equal(onMessages.filter((message) => message.role === "system").length, 2);
  assert.equal(onMessages[0].role, "system");
  assert.equal(String(onMessages[0].content).includes("研究交付进度"), false);
  assert.equal(onMessages[2].role, "system");
  assert.match(String(onMessages[2].content), /研究交付进度/);
  const onTrace = traceOf(onResult);
  assert.equal(onTrace.policy.enabled, true);
  assert.equal(onTrace.system.hoisted, 0);
  assert.ok(onTrace.policy.notes.includes("tail-stable-system-merge"));
});

test("transport：Phase 2 在同一任务阶段锁定思考档位，避免端点前置思考提示词切换", async () => {
  const messages = [sys("规则"), user("做计划")];
  const tools = [tool("a")];
  const caps = { reasoning: "deepseek_thinking", tools: "native" };
  const lockedFetch = capturingFetch({ prompt_tokens: 90, completion_tokens: 4 });
  const locked = new DeepSeekTransport({ apiKey: "fixture", capabilities: caps, prefixPolicy: true, fetchImpl: lockedFetch.fetchImpl });
  await locked.chat({ messages, tools, stage: "plan" });
  const lockedResult = await locked.chat({ messages, tools, stage: "summary" });
  assert.deepEqual(lockedFetch.bodies.map((body) => body.reasoning_effort), ["max", "max"]);
  const lockedTrace = traceOf(lockedResult);
  assert.equal(lockedTrace.policy.effortLocked, true);
  assert.ok(lockedTrace.policy.notes.includes("reasoning-effort-locked"));
  assert.equal(lockedTrace.effort.changed, false);
  assert.equal(lockedTrace.cache.prefixInvalidatingChange, false);

  // 默认关闭时不得锁定：阶段路由照旧，档位切换如实标记为前缀失效事件。
  const openFetch = capturingFetch({ prompt_tokens: 90, completion_tokens: 4 });
  const open = new DeepSeekTransport({ apiKey: "fixture", capabilities: caps, fetchImpl: openFetch.fetchImpl });
  await open.chat({ messages, tools, stage: "plan" });
  const openResult = await open.chat({ messages, tools, stage: "summary" });
  assert.deepEqual(openFetch.bodies.map((body) => body.reasoning_effort), ["max", "low"]);
  const openTrace = traceOf(openResult);
  assert.equal(openTrace.policy.effortLocked, false);
  assert.equal(openTrace.effort.changed, true);
  assert.deepEqual(openTrace.cache.changedSegments, ["effort"]);
  assert.equal(openTrace.cache.prefixInvalidatingChange, true);
  assert.equal(openTrace.cache.expectedCacheableTokens, 0);
});

test("transport：CM_PREFIX_POLICY 环境变量等价显式开关", async () => {
  const previous = process.env.CM_PREFIX_POLICY;
  try {
    process.env.CM_PREFIX_POLICY = "1";
    const captured = capturingFetch();
    const transport = new DeepSeekTransport({ apiKey: "fixture", capabilities: { tools: "json" }, fetchImpl: captured.fetchImpl });
    const result = await transport.chat({ messages: [sys("规则"), user("hi")], tools: [tool("a")] });
    assert.equal(traceOf(result).policy.enabled, true);
  } finally {
    if (previous === undefined) delete process.env.CM_PREFIX_POLICY;
    else process.env.CM_PREFIX_POLICY = previous;
  }
});

test("transport：请求失败时错误 telemetry 同样携带 prefixTrace", async () => {
  const transport = new DeepSeekTransport({
    apiKey: "fixture",
    maxRetries: 0,
    fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
  });
  await assert.rejects(
    () => transport.chat({ messages: [sys("规则"), user("hi")], round: 2, tools: [] }),
    (error: any) => {
      assert.equal(error.telemetry.prefixTrace.version, PREFIX_TRACE_VERSION);
      assert.equal(error.telemetry.prefixTrace.round, 2);
      assert.equal(error.telemetry.prefixTrace.cache.basis, "no-baseline");
      return true;
    },
  );
});

test("agent-loop：模型请求事件复用现有 llm.response telemetry 携带 prefixTrace（含 round）", async () => {
  const captured = capturingFetch();
  const transport = new DeepSeekTransport({ apiKey: "fixture", capabilities: { tools: "native" }, fetchImpl: captured.fetchImpl });
  const responses: any[] = [];
  const result = await runAgentLoop({
    system: "fixture-rules",
    user: "给我一句完成",
    deps: {
      transport,
      tools: [],
      budget: DEFAULT_BUDGET,
      executeTool: async () => "{}",
      hooks: { onEvent: (type, payload) => { if (type === "llm.response") responses.push(payload); } },
    },
  });
  assert.equal(result.rounds, 1);
  assert.equal(responses.length, 1);
  const trace = responses[0].telemetry?.prefixTrace as PrefixTrace | undefined;
  assert.ok(trace, "llm.response payload.telemetry.prefixTrace 必须存在");
  assert.equal(trace.round, 0);
  assert.equal(trace.requestSeq, 0);
  assert.equal(trace.policy.enabled, false);
  assert.equal(trace.stage, "simple");
});
