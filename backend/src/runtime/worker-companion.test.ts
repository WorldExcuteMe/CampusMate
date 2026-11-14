import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Worker } from "./worker.ts";
import { InMemoryStore } from "./store.ts";
import { InMemoryApprovalStore } from "./approval.ts";
import { CompanionRegistry } from "../core/companion.ts";
import { CompanionServer } from "../core/companion-server.ts";
import { CompanionClient } from "../core/companion-client.ts";
import type { LlmTransport } from "../core/llm.ts";
import type { ChatResult, ToolDef, ChatMessage } from "../core/types.ts";

const tools: ToolDef[] = [{ type: "function", function: { name: "run_terminal", description: "x", parameters: { type: "object", properties: {} } } }];

class TermTransport implements LlmTransport {
  async chat(opts: { messages: ChatMessage[] }): Promise<ChatResult> {
    const last = opts.messages.filter((m) => m.role === "tool").pop();
    if (last && !String(last.content).includes("__approval_pending__")) return { content: "done", toolCalls: [], usage: { input: 1, output: 1 }, model: "fake" };
    return { content: "", toolCalls: [{ id: `c${opts.messages.length}`, type: "function", function: { name: "run_terminal", arguments: JSON.stringify({ command: "ls" }) } }], usage: { input: 1, output: 1 }, model: "fake" };
  }
}

test("Worker 本机工具经 Companion WSS RPC 执行（授权+审批+出站）", async () => {
  const registry = new CompanionRegistry();
  const httpServer = http.createServer();
  const cs = new CompanionServer(httpServer, { registry, authenticate: async (t) => t === "tok" ? { userId: "u1", capabilities: ["host.terminal"], grantedScopes: { terminalAllowlist: ["ls"] } } : null, rpcTimeoutMs: 3000 });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as AddressInfo).port;
  let companionRan = 0;
  const client = new CompanionClient({ url: `ws://127.0.0.1:${port}/companion`, token: "tok", handleTool: async (tool, args) => { companionRan++; return { stdout: `companion ran ${tool} ${args.command}`, code: 0 }; }, heartbeatMs: 1e9, reconnectMs: 1e9 });
  client.connect();
  await new Promise((r) => setTimeout(r, 150));

  const store = new InMemoryStore();
  const approvals = new InMemoryApprovalStore();
  const t = await store.createTask({ userId: "u1", title: "本机任务" });
  const deps = { store, transport: new TermTransport(), tools, approvals, companion: registry, companionServer: cs, buildSystem: () => "s", executeTool: async () => JSON.stringify({ error: "不应走云执行" }), workerId: "w1", heartbeatMs: 1e9 };
  try {
    await new Worker(deps).tick(); // 授权 ok（Companion 已注册）→ 需审批 → needs_input
    assert.equal((await store.getTask(t.id))?.status, "needs_input");
    assert.equal(companionRan, 0); // 未批准不执行
    const pending = await approvals.listPendingByUser("u1");
    await approvals.decide(pending[0].id, "u1", "approved");
    await store.updateTask(t.id, { status: "queued" });
    await new Worker(deps).tick(); // 批准 → 经 WSS RPC 在 Companion 执行
    const done = await store.getTask(t.id);
    assert.equal(done?.status, "succeeded");
    assert.equal(companionRan, 1); // Companion 真实执行
  } finally {
    client.stop(); cs.close(); await new Promise<void>((r) => httpServer.close(() => r()));
  }
});