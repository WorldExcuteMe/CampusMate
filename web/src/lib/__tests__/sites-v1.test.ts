// @vitest-environment node
// 受控假 DB / 假 Cloud：验证 owner 谓词、CAS、幂等、事件序号与产物校验。
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSitesV1, type SitesV1Cloud, type SitesV1Config, type SitesV1Database, type SitesV1Query } from "../../../functions/sites-v1";

type Row = Record<string, unknown>;

// 以 WHERE 先匹配、再合并 patch 的方式模拟条件更新；insertIfAbsent 按冲突列判重。
function fakeDb() {
  const tables = new Map<string, Row[]>();
  const list = (table: string) => {
    let rows = tables.get(table);
    if (!rows) { rows = []; tables.set(table, rows); }
    return rows;
  };
  const db: SitesV1Database = {
    from(table) {
      let method: "read" | "update" | "insert" = "read";
      let columns = "*", conflict = "id";
      let patch: Row = {}, values: Row = {};
      let filters: [string, unknown][] = [];
      let max: number | undefined;
      const project = (row: Row) => columns === "*" ? structuredClone(row)
        : Object.fromEntries(columns.split(",").map(key => [key.trim(), structuredClone(row[key.trim()])]));
      const execute = async () => {
        const rows = list(table);
        if (method === "update") {
          const target = rows.find(row => filters.every(([key, value]) => row[key] === value));
          if (!target) return { data: [] };
          Object.assign(target, structuredClone(patch));
          return { data: [project(target)] };
        }
        if (method === "insert") {
          if (rows.some(row => row[conflict] === values[conflict])) return { data: [] };
          const row = structuredClone(values);
          rows.push(row);
          return { data: [project(row)] };
        }
        let found = rows.filter(row => filters.every(([key, value]) => row[key] === value));
        if (max !== undefined) found = found.slice(0, max);
        return { data: found.map(project) };
      };
      const query: SitesV1Query = {
        select(next) { columns = next; return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        limit(value) { max = value; return query; },
        update(next) { method = "update"; patch = next; return query; },
        insertIfAbsent(next, options) { method = "insert"; values = next; conflict = options.onConflict; return query; },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      return query;
    },
  };
  return {
    db, tables,
    seed(table: string, row: Row) { list(table).push(structuredClone(row)); },
  };
}

function fakeCloud() {
  return {
    createSession: vi.fn(async () => ({ id: "sess_cloud_1" })),
    sendMessage: vi.fn(async () => []),
    sendEvent: vi.fn(async () => ({})),
    listEvents: vi.fn(async () => ({ data: [] as unknown[], next_page: null })),
    streamEvents: vi.fn(async () => new Response("", { headers: { "Content-Type": "text/event-stream" } })),
    cancelSession: vi.fn(async () => {}),
    getDownloadLink: vi.fn(async () => ({ url: "https://files.example/notice.md", expires_at: "2035-01-01T00:00:00Z" })),
    fetch: vi.fn(async () => new Response("# 通知\n内容", { status: 200 })),
  };
}

const config: SitesV1Config = {
  agent: { id: "agent_test", version: 2 },
  environmentId: "env_test",
  providers: [{ id: "builtin", displayName: "托管模型", model: "campus-model", apiKey: "secret-key" }],
  capabilities: { approvals: true },
};

function fixture(initialOwner = "owner-a") {
  const db = fakeDb(), cloud = fakeCloud();
  let owner = initialOwner;
  const handler = createSitesV1({
    db: db.db,
    cloud: cloud as unknown as SitesV1Cloud,
    config,
    ownerOf: () => owner,
  });
  const req = (method: string, path: string, body?: unknown) => new Request(`https://campus.example${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const call = (method: string, path: string, body?: unknown) => handler({ request: req(method, path, body) });
  return { db, cloud, handler, call, setOwner: (value: string) => { owner = value; } };
}

async function seedSession(f: ReturnType<typeof fixture>) {
  const response = await f.call("POST", "/v1/sessions", { id: "sess_1", title: "会话", mode: "auto" });
  expect(response.status).toBe(201);
}

async function seedTask(f: ReturnType<typeof fixture>, turnId = "turn_1") {
  const response = await f.call("POST", "/v1/tasks", { title: "帮我整理通知", sessionId: "sess_1", turnId });
  expect(response.status).toBe(201);
  return (await response.json()).taskId as string;
}

describe("Sites V1 会话 CAS 与任务幂等", () => {
  it("PATCH 必须携带 expectedRevision，冲突返回 409 且不覆盖", async () => {
    const f = fixture();
    await seedSession(f);
    const ok = await f.call("PATCH", "/v1/sessions/sess_1", { title: "新标题", expectedRevision: 0 });
    expect(ok.status).toBe(200);
    expect((await ok.json()).session).toMatchObject({ title: "新标题", revision: 1 });

    const stale = await f.call("PATCH", "/v1/sessions/sess_1", { title: "旧写", expectedRevision: 0 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "revision_conflict" });

    const read = await f.call("GET", "/v1/sessions/sess_1");
    expect((await read.json()).session.title).toBe("新标题");
    expect((await f.call("PATCH", "/v1/sessions/sess_1", { title: "无版本" })).status).toBe(400);
  });

  it("同一 turnId 只创建一次任务、只绑定一次 Cloud Session、只发一次 user.message", async () => {
    const f = fixture();
    await seedSession(f);
    const first = await f.call("POST", "/v1/tasks", { title: "整理通知", sessionId: "sess_1", turnId: "turn_1" });
    expect(first.status).toBe(201);
    const created = await first.json();
    const second = await f.call("POST", "/v1/tasks", { title: "整理通知", sessionId: "sess_1", turnId: "turn_1" });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ taskId: created.taskId, deduped: true });

    expect(f.cloud.createSession).toHaveBeenCalledTimes(1);
    expect(f.cloud.sendMessage).toHaveBeenCalledTimes(1);
    const tasks = await (await f.call("GET", "/v1/sessions/sess_1/tasks")).json();
    expect(tasks.tasks).toHaveLength(1);
    const session = f.db.tables.get("campusmate_conversations")?.[0];
    expect(session?.cloud_session_id).toBe("sess_cloud_1");
  });

  it("并发提交同一 turnId 时只有一个请求创建任务并发送消息", async () => {
    const f = fixture();
    await seedSession(f);
    const responses = await Promise.all([1, 2, 3].map(() =>
      f.call("POST", "/v1/tasks", { title: "整理通知", sessionId: "sess_1", turnId: "turn_race" })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 200, 201]);
    expect(f.cloud.createSession).toHaveBeenCalledTimes(1);
    expect(f.cloud.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("Sites V1 事件翻译与去重", () => {
  it("cloud 事件映射为递增 seq 的 AgentEvent，重放按 cloud_event_id 去重", async () => {
    const f = fixture();
    await seedSession(f);
    const taskId = await seedTask(f);
    f.cloud.listEvents.mockResolvedValue({
      data: [
        { id: "evt_1", type: "agent.tool_use", name: "Write", tool_use_id: "evt_1" },
        { id: "evt_2", type: "agent.tool_result", tool_use_id: "evt_1", is_error: false, duration_ms: 12, content: "已写入" },
        { id: "evt_3", type: "agent.message", content: [{ type: "text", text: "完成" }] },
        { id: "evt_4", type: "agent.thinking", reasoning_content: "private-reasoning" },
      ],
      next_page: null,
    });

    const first = await (await f.call("GET", `/v1/tasks/${taskId}/events`)).json();
    expect(first.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(first.events.map((event: { type: string }) => event.type)).toEqual([
      "tool.called", "step.started", "tool.result", "llm.delta", "step.started",
    ]);
    expect(JSON.stringify(first.events)).not.toContain("private-reasoning");
    expect(first.events[2].payload).toMatchObject({ ok: true, durationMs: 12, summary: "已写入" });

    // 同一批云端事件重放：seq 不得重复或空洞。
    const replay = await (await f.call("GET", `/v1/tasks/${taskId}/events`)).json();
    expect(replay.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    const row = f.db.tables.get("campusmate_tasks")?.find(task => task.id === taskId);
    expect(row?.last_cloud_event_id).toBe("evt_4");
  });

  it("idle 终态把累积的 llm.delta 写成 assistant 消息与 result.summary", async () => {
    const f = fixture();
    await seedSession(f);
    const taskId = await seedTask(f);
    f.cloud.listEvents.mockResolvedValue({
      data: [
        { id: "evt_m1", type: "agent.message", content: [{ type: "text", text: "第一段" }] },
        { id: "evt_m2", type: "agent.message", content: [{ type: "text", text: "第二段" }] },
        { id: "evt_idle", type: "agent.idle", stop_reason: { type: "end_turn" } },
      ],
      next_page: null,
    });
    await f.call("GET", `/v1/tasks/${taskId}/events`);

    const task = (await (await f.call("GET", `/v1/tasks/${taskId}`)).json()).task;
    expect(task.status).toBe("succeeded");
    expect(task.result.summary).toBe("第一段第二段");
    const history = await (await f.call("GET", "/v1/sessions/sess_1/history")).json();
    expect(history.messages.find((message: { role: string }) => message.role === "assistant").content).toBe("第一段第二段");
  });

  it("自定义领域工具内联写入 owner 表并回送 user.custom_tool_result", async () => {
    const f = fixture();
    await seedSession(f);
    const taskId = await seedTask(f);
    f.cloud.listEvents.mockResolvedValue({
      data: [{ id: "evt_inbox", type: "custom_tool_use", name: "save_to_inbox", tool_use_id: "tool_2", input: { title: "讲座", summary: "周五" } }],
      next_page: null,
    });
    await f.call("GET", `/v1/tasks/${taskId}/events`);
    const inbox = f.db.tables.get("campusmate_inbox") ?? [];
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ owner_id: "owner-a" });
    expect((inbox[0].data as Row).title).toBe("讲座");
    expect(f.cloud.sendEvent).toHaveBeenCalledWith(
      "sess_cloud_1",
      expect.objectContaining({ type: "user.custom_tool_result", tool_use_id: "tool_2", is_error: false }),
    );

    f.setOwner("owner-b");
    expect((await (await f.call("GET", "/v1/domain/inbox")).json()).inbox).toHaveLength(0);
  });
});

describe("Sites V1 历史游标", () => {
  it("初始页返回最新轮次，before/after 游标可翻旧与增量", async () => {
    const f = fixture();
    await seedSession(f);
    for (const [index, turn] of ["turn_1", "turn_2", "turn_3"].entries()) {
      const imported = await f.call("POST", "/v1/sessions/sess_1/import", {
        messages: [{ role: "user", content: `第 ${index + 1} 条`, turnId: turn }],
      });
      expect(imported.status).toBe(200);
    }

    const page = await (await f.call("GET", "/v1/sessions/sess_1/history/page?limit=2")).json();
    expect(page.items.map((item: { key: string }) => item.key)).toEqual(["turn_2", "turn_3"]);
    expect(page.hasMore).toBe(true);
    expect(typeof page.before).toBe("string");
    expect(typeof page.after).toBe("string");

    const older = await (await f.call(
      "GET", `/v1/sessions/sess_1/history/page?limit=2&before=${encodeURIComponent(page.before)}`,
    )).json();
    expect(older.items.map((item: { key: string }) => item.key)).toEqual(["turn_1"]);
    expect(older.hasMore).toBe(false);

    const empty = await (await f.call(
      "GET", `/v1/sessions/sess_1/history/changes?after=${encodeURIComponent(page.after)}`,
    )).json();
    expect(empty.items).toHaveLength(0);

    await f.call("POST", "/v1/sessions/sess_1/import", {
      messages: [{ role: "user", content: "第 4 条", turnId: "turn_4" }],
    });
    const changes = await (await f.call(
      "GET", `/v1/sessions/sess_1/history/changes?after=${encodeURIComponent(page.after)}`,
    )).json();
    expect(changes.items.map((item: { key: string }) => item.key)).toEqual(["turn_4"]);
    expect(changes.hasMore).toBe(false);
  });
});

describe("Sites V1 产物与审批", () => {
  it("产物 Markdown 懒加载计算 sha256，下载头与正文一致", async () => {
    const f = fixture();
    await seedSession(f);
    const taskId = await seedTask(f);
    f.cloud.listEvents.mockResolvedValue({
      data: [{ id: "evt_file", type: "agent.artifact_delivered", file_id: "file_1", original_filename: "通知.md", content_type: "text/markdown", size: 4 }],
      next_page: null,
    });
    await f.call("GET", `/v1/tasks/${taskId}/events`);

    const body = "# 通知\n内容";
    const digest = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
    const response = await f.call("GET", "/v1/artifacts/file_1");
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.artifact.inline).toEqual({ format: "md", text: body });
    expect(view.artifact.sha256).toBe(digest);
    expect(view.availableFormats).toEqual(["md"]);
    expect(f.cloud.getDownloadLink).toHaveBeenCalledWith("file_1");

    const download = await f.call("GET", "/v1/artifacts/file_1/download?format=md");
    expect(download.status).toBe(200);
    expect(download.headers.get("X-File-Sha256")).toBe(digest);
    expect(download.headers.get("Content-Disposition")).toContain(`filename*=UTF-8''${encodeURIComponent("通知.md")}`);
    expect(await download.text()).toBe(body);
  });

  it("ask 工具创建审批并 needs_input；decide 回送 tool_confirmation 且重复决定幂等", async () => {
    const f = fixture();
    await seedSession(f);
    const taskId = await seedTask(f);
    f.cloud.listEvents.mockResolvedValue({
      data: [{ id: "evt_ask", type: "custom_tool_use", name: "ask", tool_use_id: "tool_1", input: { question: "确认执行?", risk: "write" } }],
      next_page: null,
    });
    const listed = await (await f.call("GET", `/v1/tasks/${taskId}/events`)).json();
    expect(listed.task.status).toBe("needs_input");
    expect(listed.events.map((event: { type: string }) => event.type)).toContain("task.needs_input");

    const approvals = (await (await f.call("GET", "/v1/approvals")).json()).approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ taskId, toolName: "ask", status: "pending" });

    const decided = await f.call("POST", `/v1/approvals/${approvals[0].id}`, { decision: "approved" });
    expect(decided.status).toBe(200);
    expect(f.cloud.sendEvent).toHaveBeenCalledWith(
      "sess_cloud_1",
      expect.objectContaining({ type: "user.tool_confirmation", tool_use_id: "tool_1", decision: "approved" }),
    );
    const task = (await (await f.call("GET", `/v1/tasks/${taskId}`)).json()).task;
    expect(task.status).toBe("running");

    const again = await f.call("POST", `/v1/approvals/${approvals[0].id}`, { decision: "approved" });
    expect(again.status).toBe(200);
    expect((await again.json()).deduped).toBe(true);
    expect(f.cloud.sendEvent).toHaveBeenCalledTimes(1);
  });
});

describe("Sites V1 跨 owner 隔离与只读托管项", () => {
  it("其他 owner 无法读取会话/任务/产物、无法创建任务或看到审批", async () => {
    const f = fixture();
    await seedSession(f);
    const taskId = await seedTask(f);
    f.cloud.listEvents.mockResolvedValue({
      data: [{ id: "evt_ask", type: "custom_tool_use", name: "ask", tool_use_id: "tool_1", input: {} }],
      next_page: null,
    });
    await f.call("GET", `/v1/tasks/${taskId}/events`);
    f.db.seed("campusmate_artifacts", {
      id: "file_1", owner_id: "owner-a", task_id: taskId, cloud_file_id: "file_1",
      filename: "a.md", content_type: "text/markdown", size: 1, sha256: null, inline: null, created_at: Date.now(),
    });

    f.setOwner("owner-b");
    for (const path of [
      "/v1/sessions/sess_1", "/v1/sessions/sess_1/history", "/v1/sessions/sess_1/tasks",
      `/v1/tasks/${taskId}`, `/v1/tasks/${taskId}/events`, "/v1/artifacts/file_1",
    ]) {
      expect((await f.call("GET", path)).status).toBe(404);
    }
    expect((await f.call("POST", "/v1/tasks", { title: "x", sessionId: "sess_1", turnId: "turn_b" })).status).toBe(404);
    expect((await (await f.call("GET", "/v1/approvals")).json()).approvals).toHaveLength(0);
  });

  it("providers 仅暴露托管条目的公开字段，不含密钥", async () => {
    const f = fixture();
    const response = await f.call("GET", "/v1/providers");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.mutable).toBe(false);
    expect(body.providers[0]).toMatchObject({ id: "builtin", displayName: "托管模型", modelId: "campus-model", managed: true, builtin: true, hasKey: true });
    expect(JSON.stringify(body)).not.toContain("secret-key");
    // 未注入 vault 时 BYOK 写入被明确拒绝（403），而不是伪装成只读 405。
    expect((await f.call("POST", "/v1/providers", {})).status).toBe(403);
  });
});

describe("思考摘要与参数摘要映射", () => {
  it("thinking 有 content 时落有界摘要；tool_use input 只落短参数摘要", async () => {
    const f = fixture();
    await seedSession(f);
    const taskId = await seedTask(f);
    f.cloud.listEvents.mockResolvedValue({
      data: [
        { id: "evt_tool", type: "agent.tool_use", name: "save_to_inbox", tool_use_id: "t1", input: { title: "讲座", content: "长正文".repeat(100) } },
        { id: "evt_think", type: "agent.thinking", content: [{ type: "text", text: "先核对时间再保存".repeat(40) }] },
      ],
      next_page: null,
    });
    const body = await (await f.call("GET", `/v1/tasks/${taskId}/events`)).json();
    const types = body.events.map((event: { type: string }) => event.type);
    expect(types).toContain("thinking.summary");
    const summary = body.events.find((event: { type: string }) => event.type === "thinking.summary");
    expect(summary.payload.excerpt.length).toBeLessThanOrEqual(240);
    expect(summary.payload.chars).toBeGreaterThan(240);
    const called = body.events.find((event: { type: string }) => event.type === "tool.called");
    expect(String(called.payload.argsSummary)).toContain("title=讲座");
    expect(String(called.payload.argsSummary).length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(body.events)).not.toContain("长正文".repeat(20));
  });
});
