import { test } from "node:test";
import assert from "node:assert/strict";
import { CapabilityRegistry, registerCloudDefaults, cloudProviders } from "./capability.ts";
import { buildManifest, resolveCapability, manifestHas, manifestToolNames, ALTERNATIVES } from "./manifest.ts";
import { manifestTools, TOOL_SPECS, toolRequiresApproval } from "./tool-registry.ts";
import { CompanionRegistry } from "./companion.ts";
import { CLOUD_TOOLS } from "./cloud-tools.ts";
import { DEFAULT_BUDGET } from "./types.ts";
import type { ToolDef } from "./types.ts";

const allTools: ToolDef[] = [
  ...CLOUD_TOOLS,
  { type: "function", function: { name: "run_terminal", description: "x", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "sync_group_notices", description: "x", parameters: { type: "object", properties: {} } } },
];

function reg(): CapabilityRegistry { const r = new CapabilityRegistry(); registerCloudDefaults(r); return r; }

test("云端默认注册不含本机能力", () => {
  const r = reg();
  assert.ok(r.has("llm.chat"));
  assert.ok(r.has("web.fetch"));
  assert.ok(!r.has("host.terminal"));
  assert.ok(!r.has("ingest.qq"));
  assert.equal(cloudProviders().every((p) => p.runtime === "cloud"), true);
});

test("健康检查：未注册能力 available=false", async () => {
  const r = reg();
  const h = await r.healthCheck("host.terminal");
  assert.equal(h.available, false);
  assert.match(h.reason ?? "", /未注册/);
});

test("Manifest 云端默认无本机工具；Companion 注册后叠加", () => {
  const r = reg();
  const companion = new CompanionRegistry();
  const m1 = buildManifest({ registry: r, companion, userId: "u1", taskId: "t1", budget: DEFAULT_BUDGET });
  assert.equal(m1.runtime, "cloud");
  assert.ok(!manifestToolNames(m1).has("run_terminal"));
  assert.ok(manifestToolNames(m1).has("web_search"));
  companion.register({ userId: "u1", capabilities: ["host.terminal", "ingest.qq"], grantedScopes: { terminalAllowlist: ["ls"], qqGroups: ["111"] } });
  const m2 = buildManifest({ registry: r, companion, userId: "u1", taskId: "t1", budget: DEFAULT_BUDGET });
  assert.equal(m2.runtime, "local-companion");
  assert.ok(manifestToolNames(m2).has("run_terminal"));
  assert.ok(manifestToolNames(m2).has("sync_group_notices"));
  // 其他用户不可见
  const m3 = buildManifest({ registry: r, companion, userId: "u2", taskId: "t2", budget: DEFAULT_BUDGET });
  assert.ok(!manifestToolNames(m3).has("run_terminal"));
});

test("能力缺失发现与替代：ingest.qq 缺失→web.search", () => {
  const r = reg();
  const m = buildManifest({ registry: r, userId: "u1", taskId: "t1", budget: DEFAULT_BUDGET });
  assert.equal(manifestHas(m, "ingest.qq"), false);
  const res = resolveCapability(m, "ingest.qq");
  assert.ok("use" in res && res.use === "web.search");
  assert.equal(ALTERNATIVES["ingest.qq"], "web.search");
});

test("能力缺失无替代→明确报告不可用（禁止假装）", () => {
  const r = reg();
  const m = buildManifest({ registry: r, userId: "u1", taskId: "t1", budget: DEFAULT_BUDGET });
  const res = resolveCapability(m, "host.terminal");
  assert.ok("unavailable" in res && res.unavailable === true);
  assert.equal(res.action, "request_user_or_report");
});

test("Manifest 工具门控：云端只见云工具，本机工具不可见", () => {
  const r = reg();
  const m = buildManifest({ registry: r, userId: "u1", taskId: "t1", budget: DEFAULT_BUDGET });
  const visible = manifestTools(m, allTools).map((t) => t.function.name);
  assert.ok(visible.includes("web_search"));
  assert.ok(visible.includes("web_fetch"));
  assert.ok(!visible.includes("run_terminal"));
  assert.ok(!visible.includes("sync_group_notices"));
});

test("ToolSpec 元数据：本机工具需审批，云只读不需要", () => {
  assert.equal(toolRequiresApproval("run_terminal"), true);
  assert.equal(toolRequiresApproval("write_file"), true);
  assert.equal(toolRequiresApproval("create_opportunity"), true);
  assert.equal(toolRequiresApproval("web_search"), false);
  assert.equal(TOOL_SPECS["run_terminal"].runtime.includes("cloud"), false);
  assert.equal(TOOL_SPECS["web_fetch"].sideEffects, "network");
});