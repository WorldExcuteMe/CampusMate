import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CompanionServer } from "./companion-server.ts";
import { CompanionClient } from "./companion-client.ts";
import { CompanionRegistry } from "./companion.ts";

async function setup(handleTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>, authOk = true) {
  const registry = new CompanionRegistry();
  const server = http.createServer();
  const cs = new CompanionServer(server, {
    registry,
    authenticate: async (token) => authOk && token === "dev-token" ? { userId: "u1", capabilities: ["host.terminal"], grantedScopes: { terminalAllowlist: ["ls"] } } : null,
    rpcTimeoutMs: 2000,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const client = new CompanionClient({ url: `ws://127.0.0.1:${port}/companion`, token: "dev-token", handleTool, heartbeatMs: 1e9, reconnectMs: 1e9 });
  client.connect();
  await new Promise((r) => setTimeout(r, 150)); // 等待注册
  return { registry, cs, client, server, port };
}
const teardown = async (s: { client: CompanionClient; cs: CompanionServer; server: http.Server }) => { s.client.stop(); s.cs.close(); await new Promise<void>((r) => s.server.close(() => r())); };

test("Companion 出站注册 → 能力进入 Registry", async () => {
  const s = await setup(async () => ({}));
  try {
    assert.equal(s.client.registered, true);
    assert.equal(s.cs.isConnected("u1"), true);
    assert.equal(s.registry.hasCapability("u1", "host.terminal"), true);
  } finally { await teardown(s); }
});

test("Backend RPC 分派本机工具 → Companion 执行返回结果", async () => {
  const s = await setup(async (tool, args) => ({ stdout: `ran ${tool} ${args.command ?? ""}`, code: 0 }));
  try {
    const result = await s.cs.invoke("u1", "run_terminal", { command: "ls" }) as { stdout: string };
    assert.match(result.stdout, /ran run_terminal ls/);
  } finally { await teardown(s); }
});

test("Companion 工具报错 → RPC reject", async () => {
  const s = await setup(async () => { throw new Error("命令越界"); });
  try {
    await assert.rejects(() => s.cs.invoke("u1", "run_terminal", { command: "rm" }), /命令越界/);
  } finally { await teardown(s); }
});

test("未连接用户 RPC → 拒绝（本机能力不可用）", async () => {
  const s = await setup(async () => ({}));
  try {
    await assert.rejects(() => s.cs.invoke("u2", "run_terminal", {}), /Companion 未连接/);
  } finally { await teardown(s); }
});

test("认证失败 → 不注册", async () => {
  const registry = new CompanionRegistry();
  const server = http.createServer();
  const cs = new CompanionServer(server, { registry, authenticate: async () => null, rpcTimeoutMs: 1000 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const client = new CompanionClient({ url: `ws://127.0.0.1:${port}/companion`, token: "bad", handleTool: async () => ({}), heartbeatMs: 1e9, reconnectMs: 1e9 });
  client.connect();
  await new Promise((r) => setTimeout(r, 150));
  try {
    assert.equal(client.registered, false);
    assert.equal(cs.isConnected("u1"), false);
  } finally { client.stop(); cs.close(); await new Promise<void>((r) => server.close(() => r())); }
});