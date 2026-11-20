// @vitest-environment node
// P0 production wiring contract: official QCA helper + durable coordinator binding.
// These tests use a fake Sites database and a fake Cloud Agents origin; they do
// not prove a real deployment or consume any Cloud Agents quota.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createProductionSites } from "../../../functions/sites-production";
import { CAMPUSMATE_SITES } from "../../../functions/sites-config";
import type { SitesDatabase, SitesQuery } from "../../../functions/sites-database";

const origin = CAMPUSMATE_SITES.siteOrigin;
const bindingKey = `sites:binding:${CAMPUSMATE_SITES.applicationScope}`;

function databaseFixture() {
  const tables: Record<string, Record<string, unknown>[]> = { campusmate_runtime: [], campusmate_locks: [] };
  let failWrite = false;
  const db: SitesDatabase = { from(table) {
    const rows = tables[table];
    if (!rows) throw new Error(`unexpected_table:${table}`);
    let method = "read", data: Record<string, unknown> = {}, columns = "", conflict = "";
    const filters: [string, unknown][] = [];
    const project = (row: Record<string, unknown>) => Object.fromEntries(
      columns.split(",").filter(Boolean).map(key => [key, structuredClone(row[key])]),
    );
    const execute = async () => {
      if (method !== "read" && failWrite) throw new Error("private-provider-error");
      if (method === "insert") {
        if (rows.some(row => row[conflict] === data[conflict])) return { data: [], error: null };
        rows.push(structuredClone(data));
        return { data: [project(data)], error: null };
      }
      if (method === "update") {
        const target = rows.find(row => filters.every(([key, value]) => row[key] === value));
        if (!target) return { data: [], error: null };
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, structuredClone(data));
        return { data: [project(target)], error: null };
      }
      return { data: rows.filter(row => filters.every(([key, value]) => row[key] === value)).map(project), error: null };
    };
    const query: SitesQuery = {
      select(value) { columns = value; return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      limit(value) { expect(value).toBe(1); return query; },
      update(value) { method = "update"; data = value; return query; },
      insertIfAbsent(value, options) { conflict = options.onConflict; method = "insert"; data = value; return query; },
      then(resolve, reject) { return execute().then(resolve, reject); },
    };
    return query;
  } };
  return {
    db,
    lockRow: (key: string) => tables.campusmate_locks.find(row => row.lock_key === key) ?? null,
    seedLock: (row: Record<string, unknown>) => { tables.campusmate_locks.push(structuredClone(row)); },
    fail: () => { failWrite = true; },
  };
}

interface CloudCall { method: string; path: string; url: string; body?: any; idempotencyKey?: string | null }
function cloudFixture(enabled: boolean) {
  const agents: Record<string, unknown>[] = [];
  const environments: Record<string, unknown>[] = [];
  const calls: CloudCall[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({
      method, path: url.pathname, url: `${url.origin}${url.pathname}${url.search}`, ...(body === undefined ? {} : { body }),
      ...(headers.has("Idempotency-Key") ? { idempotencyKey: headers.get("Idempotency-Key") } : {}),
    });
    if (url.pathname === "/api/v1/cloud/models") {
      return Response.json({ data: [{ id: "ultimate", is_enabled: enabled }], has_more: false, next_page: null });
    }
    if (url.pathname === "/api/v1/cloud/agents" && method === "GET") {
      return Response.json({ data: agents, has_more: false, next_page: null });
    }
    if (url.pathname === "/api/v1/cloud/environments" && method === "GET") {
      return Response.json({ data: environments, has_more: false, next_page: null });
    }
    if (url.pathname === "/api/v1/cloud/agents" && method === "POST") {
      const created = { id: "agent_test", version: 3, name: body.name, metadata: body.metadata, archived_at: null };
      agents.push(created);
      return Response.json(created);
    }
    if (url.pathname === "/api/v1/cloud/environments" && method === "POST") {
      const created = { id: "env_test", name: body.name, metadata: body.metadata, archived_at: null };
      environments.push(created);
      return Response.json(created);
    }
    if (url.pathname === "/api/v1/cloud/sessions" && method === "POST") {
      return Response.json({ id: "sess_test", status: "idle", archived_at: null });
    }
    throw new Error(`unexpected_request:${method}:${url.pathname}`);
  });
  return { fetcher, calls, agents, environments };
}

function siteRequest(path: string, options: { method?: string; body?: unknown; origin?: string } = {}) {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { Origin: options.origin ?? origin };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`${origin}/functions/v1/app${path}`, {
    method, headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function setup(patch: { enabled?: boolean; token?: string; userError?: unknown } = {}) {
  const db = databaseFixture();
  const cloud = cloudFixture(patch.enabled ?? true);
  const token = "token" in patch ? patch.token : "fixture-pat";
  const handler = createProductionSites({
    db: db.db,
    requireUser: (_context: { request: Request }) => {
      if (patch.userError) throw patch.userError;
      return { id: "owner-a" };
    },
    config: CAMPUSMATE_SITES,
    getToken: () => token,
    fetch: cloud.fetcher,
  });
  return { ...db, ...cloud, handler };
}

const recoveryPath = fileURLToPath(new URL("../../../../.local/sites/recovery-ids.json", import.meta.url));
it.skipIf(!existsSync(recoveryPath))("站点配置与 .local/sites/recovery-ids.json 一致", () => {
  const recovery = JSON.parse(readFileSync(recoveryPath, "utf8"));
  expect(CAMPUSMATE_SITES).toMatchObject({
    siteId: recovery.siteId,
    projectId: recovery.projectId,
    host: recovery.host,
    region: recovery.region,
    environment: recovery.environment,
    cloudAgentsApiOrigin: recovery.cloudAgentsApiOrigin,
    displayName: recovery.displayName,
    slug: recovery.slug,
  });
  expect(CAMPUSMATE_SITES.siteOrigin).toBe(`https://${recovery.host}`);
});

describe("生产初始化：POST /initialize", () => {
  it("检查启用模型，创建一次 Agent/Environment 并持久化绑定", async () => {
    const f = setup();
    const response = await f.handler({ request: siteRequest("/initialize", { method: "POST" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
    const paths = f.calls.map(call => `${call.method} ${call.path}`);
    expect(paths).toContain("GET /api/v1/cloud/models");
    const modelsCall = f.calls.find(call => call.method === "GET" && call.path === "/api/v1/cloud/models");
    expect(modelsCall?.url).toBe(`${CAMPUSMATE_SITES.cloudAgentsApiOrigin}/api/v1/cloud/models`);
    expect(new URL(modelsCall!.url).search).toBe("");
    expect(paths.filter(path => path === "POST /api/v1/cloud/environments")).toHaveLength(1);
    expect(paths.filter(path => path === "POST /api/v1/cloud/agents")).toHaveLength(1);
    expect(f.lockRow(bindingKey)?.record).toMatchObject({
      state: "ready", scope: CAMPUSMATE_SITES.applicationScope, model: "ultimate",
      agent: { id: "agent_test", version: 3 }, environmentId: "env_test",
    });
  });
  it("重复初始化复用持久化绑定，不再请求模型或创建资源", async () => {
    const f = setup();
    await f.handler({ request: siteRequest("/initialize", { method: "POST" }) });
    const before = f.calls.length;
    const response = await f.handler({ request: siteRequest("/initialize", { method: "POST" }) });
    expect(await response.json()).toEqual({ ready: true });
    expect(f.calls.length).toBe(before);
  });
  it("模型 is_enabled=false 时不创建任何云资源", async () => {
    const f = setup({ enabled: false });
    const response = await f.handler({ request: siteRequest("/initialize", { method: "POST" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "ai_model_not_enabled" });
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
    expect(f.lockRow(bindingKey)).toBeNull();
  });
  it("缺少平台 QODER_PAT 时不发起模型或资源请求", async () => {
    const f = setup({ token: undefined });
    const response = await f.handler({ request: siteRequest("/initialize", { method: "POST" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "ai_not_configured" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("未登录不能初始化", async () => {
    const f = setup({ userError: Object.assign(new Error("login required"), { code: "login_required", status: 401 }) });
    const response = await f.handler({ request: siteRequest("/initialize", { method: "POST" }) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "login_required" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("跨站写请求在初始化前被拒绝", async () => {
    const f = setup();
    const response = await f.handler({ request: siteRequest("/initialize", { method: "POST", origin: "https://evil.example" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe("运行路由只读绑定", () => {
  it("未初始化时 runs 返回 409，不创建 Session 或云资源", async () => {
    const f = setup();
    const response = await f.handler({ request: siteRequest("/runs", { body: { requestId: "request_1234", notice: "校园通知" } }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "sites_not_initialized" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("初始化后 runs 只用持久化绑定创建 Session，不再初始化资源", async () => {
    const f = setup();
    await f.handler({ request: siteRequest("/initialize", { method: "POST" }) });
    const before = f.calls.length;
    const response = await f.handler({ request: siteRequest("/runs", { body: { requestId: "request_1234", notice: "校园通知" } }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ run: { id: "request_1234", state: "ready" } });
    const after = f.calls.slice(before);
    expect(after.map(call => `${call.method} ${call.path}`)).toEqual(["POST /api/v1/cloud/sessions"]);
    expect(after[0].body).toMatchObject({ agent: { id: "agent_test", type: "agent", version: 3 }, environment_id: "env_test" });
  });
  it("范围不匹配的绑定记录不能被当作已初始化", async () => {
    const f = setup();
    f.seedLock({ lock_key: bindingKey, version: 1, token: "seed", expires_at: 0, record: { state: "ready", scope: "other-site" } });
    const response = await f.handler({ request: siteRequest("/runs", { body: { requestId: "request_1234", notice: "校园通知" } }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "sites_not_initialized" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
