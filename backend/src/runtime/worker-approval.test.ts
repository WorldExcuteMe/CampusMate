import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "./worker.ts";
import { InMemoryStore } from "./store.ts";
import { InMemoryApprovalStore } from "./approval.ts";
import { CompanionRegistry } from "../core/companion.ts";
import type { LlmTransport } from "../core/llm.ts";
import type { ChatResult, ToolDef, ChatMessage } from "../core/types.ts";

const tools: ToolDef[] = [
  { type: "function", function: { name: "run_terminal", description: "x", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "web_search", description: "x", parameters: { type: "object", properties: {} } } },
];
const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

function regCompanion(): CompanionRegistry {
  const c = new CompanionRegistry();
  c.register({ userId: "u1", capabilities: ["host.terminal"], grantedScopes: { terminalAllowlist: ["ls"] } });
  return c;
}

// 确定性 transport：已有非 pending 工具结果→收尾；否则发起一次工具调用（正确模拟 resume 重发）。
class StepTransport implements LlmTransport {
  tool: string; args: Record<string, unknown>;
  constructor(tool: string, args: Record<string, unknown>) { this.tool = tool; this.args = args; }
  async chat(opts: { messages: ChatMessage[] }): Promise<ChatResult> {
    const results = opts.messages.filter((m) => m.role === "tool");
    const last = results[results.length - 1];
    if (last && !String(last.content).includes("__approval_pending__")) return { content: "done", toolCalls: [], usage: { input: 1, output: 1 }, model: "fake" };
    return { content: "", toolCalls: [tc(this.tool, this.args, `c${opts.messages.length}`)], usage: { input: 1, output: 1 }, model: "fake" };
  }
}

test("高危工具无审批 → needs_input，不执行副作用", async () => {
  const store = new InMemoryStore();
  const approvals = new InMemoryApprovalStore();
  const t = await store.createTask({ userId: "u1", title: "x" });
  let executed = false;
  const w = new Worker({ store, transport: new StepTransport("run_terminal", { command: "ls" }), tools, approvals, companion: regCompanion(), buildSystem: () => "s", executeTool: async () => { executed = true; return JSON.stringify({ ok: true }); }, workerId: "w1", heartbeatMs: 1e9 });
  await w.tick();
  assert.equal((await store.getTask(t.id))?.status, "needs_input");
  assert.equal(executed, false); // 未批准不执行
  assert.equal((await approvals.listPendingByUser("u1")).length, 1);
  assert.ok((await store.listEvents(t.id)).some((e) => e.type === "tool.approval_requested"));
});

test("批准后 resume → 执行高危工具 → succeeded", async () => {
  const store = new InMemoryStore();
  const approvals = new InMemoryApprovalStore();
  const t = await store.createTask({ userId: "u1", title: "x" });
  let executed = 0;
  const deps = { store, transport: new StepTransport("run_terminal", { command: "ls" }), tools, approvals, companion: regCompanion(), buildSystem: () => "s", executeTool: async () => { executed++; return JSON.stringify({ ok: true }); }, workerId: "w1", heartbeatMs: 1e9 };
  await new Worker(deps).tick(); // → needs_input
  const pending = await approvals.listPendingByUser("u1");
  await approvals.decide(pending[0].id, "u1", "approved");
  await store.updateTask(t.id, { status: "queued" }); // resume
  await new Worker(deps).tick();
  assert.equal((await store.getTask(t.id))?.status, "succeeded");
  assert.equal(executed, 1);
});

test("拒绝后 resume → 工具被拒，不执行副作用", async () => {
  const store = new InMemoryStore();
  const approvals = new InMemoryApprovalStore();
  const t = await store.createTask({ userId: "u1", title: "x" });
  let executed = false;
  const deps = { store, transport: new StepTransport("run_terminal", { command: "ls" }), tools, approvals, companion: regCompanion(), buildSystem: () => "s", executeTool: async () => { executed = true; return "{}"; }, workerId: "w1", heartbeatMs: 1e9 };
  await new Worker(deps).tick();
  const pending = await approvals.listPendingByUser("u1");
  await approvals.decide(pending[0].id, "u1", "rejected");
  await store.updateTask(t.id, { status: "queued" });
  await new Worker(deps).tick();
  assert.equal(executed, false);
});

test("云端无 Companion → 本机工具拒绝（即使审批通过）", async () => {
  const store = new InMemoryStore();
  const approvals = new InMemoryApprovalStore();
  await store.createTask({ userId: "u1", title: "x" });
  let executed = false;
  const w = new Worker({ store, transport: new StepTransport("run_terminal", { command: "ls" }), tools, approvals, companion: new CompanionRegistry(), buildSystem: () => "s", executeTool: async () => { executed = true; return "{}"; }, workerId: "w1", heartbeatMs: 1e9 });
  await w.tick();
  assert.equal(executed, false); // 无 Companion，授权先拒绝
  assert.equal((await approvals.listPendingByUser("u1")).length, 0);
});

test("Companion 授权命令白名单 → 批准后执行；越界命令拒绝", async () => {
  const store = new InMemoryStore();
  const approvals = new InMemoryApprovalStore();
  const companion = new CompanionRegistry();
  companion.register({ userId: "u1", capabilities: ["host.terminal"], grantedScopes: { terminalAllowlist: ["ls"] } });
  const t = await store.createTask({ userId: "u1", title: "x" });
  let executed = 0;
  const deps = { store, transport: new StepTransport("run_terminal", { command: "ls -la" }), tools, approvals, companion, buildSystem: () => "s", executeTool: async () => { executed++; return JSON.stringify({ ok: true }); }, workerId: "w1", heartbeatMs: 1e9 };
  await new Worker(deps).tick(); // 授权 ok 但需审批 → needs_input
  assert.equal(executed, 0);
  const pending = await approvals.listPendingByUser("u1");
  await approvals.decide(pending[0].id, "u1", "approved");
  await store.updateTask(t.id, { status: "queued" });
  await new Worker(deps).tick();
  assert.equal(executed, 1); // 白名单内 + 批准 → 执行
});

test("云只读工具无需审批直接执行", async () => {
  const store = new InMemoryStore();
  const approvals = new InMemoryApprovalStore();
  const t = await store.createTask({ userId: "u1", title: "x" });
  const w = new Worker({ store, transport: new StepTransport("web_search", { query: "竞赛" }), tools, approvals, buildSystem: () => "s", executeTool: async () => JSON.stringify({ results: [] }), workerId: "w1", heartbeatMs: 1e9 });
  await w.tick();
  assert.equal((await store.getTask(t.id))?.status, "succeeded");
  assert.equal((await approvals.listPendingByUser("u1")).length, 0);
});