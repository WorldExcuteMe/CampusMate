import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Worker } from "./worker.ts";
import { InMemoryStore } from "./store.ts";
import { CapabilityRegistry, registerCloudDefaults } from "../core/capability.ts";
import { CompanionRegistry } from "../core/companion.ts";
import { createApiServer } from "../api/server.ts";
import { signJwt } from "../api/jwt.ts";
import type { LlmTransport } from "../core/llm.ts";
import type { ChatResult, ToolDef, ChatMessage } from "../core/types.ts";

const SECRET = "s";
const allTools: ToolDef[] = [
  { type: "function", function: { name: "web_search", description: "x", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "run_terminal", description: "x", parameters: { type: "object", properties: {} } } },
];

// 记录模型实际看到的工具集。
class CaptureTransport implements LlmTransport {
  seenTools: string[][] = [];
  async chat(opts: { messages: ChatMessage[]; tools?: ToolDef[] }): Promise<ChatResult> {
    this.seenTools.push((opts.tools ?? []).map((t) => t.function.name));
    return { content: "done", toolCalls: [], usage: { input: 1, output: 1 }, model: "fake" };
  }
}

test("Worker Manifest 门控：云端模型看不到本机工具", async () => {
  const store = new InMemoryStore();
  const registry = new CapabilityRegistry();
  registerCloudDefaults(registry);
  await store.createTask({ userId: "u1", title: "x" });
  const transport = new CaptureTransport();
  const w = new Worker({ store, transport, tools: allTools, capabilityRegistry: registry, companion: new CompanionRegistry(), buildSystem: () => "s", executeTool: async () => "{}", workerId: "w1", heartbeatMs: 1e9 });
  await w.tick();
  assert.ok(transport.seenTools[0].includes("web_search"));
  assert.ok(!transport.seenTools[0].includes("run_terminal"));
});

test("Worker Manifest：Companion 注册后本机工具可见", async () => {
  const store = new InMemoryStore();
  const registry = new CapabilityRegistry();
  registerCloudDefaults(registry);
  const companion = new CompanionRegistry();
  companion.register({ userId: "u1", capabilities: ["host.terminal"], grantedScopes: { terminalAllowlist: ["ls"] } });
  await store.createTask({ userId: "u1", title: "x" });
  const transport = new CaptureTransport();
  const w = new Worker({ store, transport, tools: allTools, capabilityRegistry: registry, companion, buildSystem: () => "s", executeTool: async () => "{}", workerId: "w1", heartbeatMs: 1e9 });
  await w.tick();
  assert.ok(transport.seenTools[0].includes("run_terminal"));
});

test("capabilities API 返回用户 Manifest（云端无本机能力）", async () => {
  const store = new InMemoryStore();
  const registry = new CapabilityRegistry();
  registerCloudDefaults(registry);
  const server = createApiServer({ store, jwtSecret: SECRET, capabilityRegistry: registry, companion: new CompanionRegistry() });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const token = signJwt({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const r = await fetch(`${base}/v1/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    const { manifest } = (await r.json()) as { manifest: { runtime: string; capabilities: { id: string; available: boolean }[] } };
    assert.equal(manifest.runtime, "cloud");
    assert.ok(manifest.capabilities.some((c) => c.id === "web.fetch" && c.available));
    assert.ok(!manifest.capabilities.some((c) => c.id === "host.terminal"));
    const noAuth = await fetch(`${base}/v1/capabilities`);
    assert.equal(noAuth.status, 401);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});