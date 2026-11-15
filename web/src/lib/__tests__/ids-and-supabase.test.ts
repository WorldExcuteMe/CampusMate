import { describe, it, expect, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { SupabaseRepository } from "../data/supabase";
import { uid } from "../data/types";
import { runInboxPipeline } from "../agent/orchestrator";
import { MockProvider } from "../llm/mock";
import { demoInbox, demoTasks } from "@/demo/seed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fixture() {
  const rows: Record<string, Record<string, any>[]> = {};
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const table = url.pathname.split("/").pop()!;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    let selected = rows[table] ??= [];
    if (method === "POST") {
      const row = JSON.parse(String(init?.body));
      if (!UUID.test(row.id)) return Response.json({ message: "invalid input syntax for type uuid", code: "22P02" }, { status: 400 });
      const prior = selected.find((r) => r.id === row.id);
      if (!prior) selected.push(row);
      else if (!headers.get("Prefer")?.includes("ignore-duplicates")) Object.assign(prior, row);
      return Response.json(null, { status: 201 });
    }
    for (const key of ["id", "user_id"]) {
      const filter = url.searchParams.get(key);
      if (filter?.startsWith("eq.")) selected = selected.filter((r) => r[key] === filter.slice(3));
    }
    return Response.json(headers.get("Accept")?.includes("vnd.pgrst.object") ? selected[0] : selected);
  });
  const client = createClient("https://fixture.supabase.co", "fixture-public-key", {
    auth: { storageKey: uid(), persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetcher },
  });
  const userId = uid();
  return { repo: new SupabaseRepository(client, userId), rows, fetcher, userId };
}

describe("UUID and real repository contract", () => {
  it("generates UUIDs for entities and agent runs", async () => {
    const ids = Array.from({ length: 100 }, uid);
    expect(ids.every((id) => UUID.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(100);
    const run = await runInboxPipeline({ rawText: "测试通知", sourceUrl: null, sourceType: "text" }, new MockProvider());
    expect(run.run.id).toMatch(UUID);
  });
  it("initializes a missing profile without overwriting existing fields", async () => {
    const { repo, rows, userId } = fixture();
    expect((await repo.getProfile()).id).toBe(userId);
    expect(rows.profiles).toHaveLength(1);
    rows.profiles[0].name = "已有姓名";
    expect((await repo.getProfile()).name).toBe("已有姓名");
    expect(rows.profiles).toHaveLength(1);
  });
  it("saves inbox/tasks with the authenticated owner and round-trips Mock provenance", async () => {
    const { repo, rows, userId } = fixture();
    const item = await repo.createInbox({ ...demoInbox[0], id: uid(), userId: "untrusted-owner", extractionMock: false });
    await repo.createTask({ ...demoTasks[0], id: uid(), inboxItemId: item.id });
    const result = await runInboxPipeline({ rawText: "测试通知", sourceUrl: null, sourceType: "text" }, new MockProvider());
    await repo.logAgentRun(result.run);
    await repo.logActivity({ id: uid(), userId: "untrusted-owner", eventType: "inbox.confirmed", entityType: "inbox_item", entityId: item.id, createdAt: new Date().toISOString() });
    for (const table of ["inbox_items", "tasks", "agent_runs", "activity_events"]) {
      expect(rows[table][0].id).toMatch(UUID);
      expect(rows[table][0].user_id).toBe(userId);
    }
    expect(item.userId).toBe(userId);
    expect((await repo.listInbox())[0].extractionMock).toBe(false);
    expect((await repo.listAgentRuns())[0]).toMatchObject({ mock: true, provider: "mock" });
  });
  it("does not silently swallow audit read/write failures", async () => {
    const { repo, fetcher } = fixture();
    fetcher.mockResolvedValue(Response.json({ message: "database unavailable" }, { status: 500 }));
    await expect(repo.listAgentRuns()).rejects.toMatchObject({ message: "database unavailable" });
    // Use a fresh Response because a response stream is single-use.
    fetcher.mockImplementation(async () => Response.json({ message: "database unavailable" }, { status: 500 }));
    await expect(repo.logAgentRun({ id: uid() } as any)).rejects.toMatchObject({ message: "database unavailable" });
  });
});
