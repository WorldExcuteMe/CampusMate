import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// mock config：supabaseClient 提供 session token；backendUrl 经 import.meta.env。
vi.mock("@/app/config", () => ({
  supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
}));

import { createTask, getTask, cancelTask, resumeTask, listEvents, backendEnabled, runTaskViaBackend, subscribeTask } from "../agent/api-client";

beforeEach(() => {
  vi.stubEnv("VITE_BACKEND_URL", "http://backend.test");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response;
  }));
}

describe("Agent API Client（AC01 前端走后端 Task API）", () => {
  it("backendEnabled 由 VITE_BACKEND_URL 决定", () => {
    expect(backendEnabled()).toBe(true);
  });

  it("createTask 携带 JWT 并返回 taskId", async () => {
    let auth = "";
    mockFetch((url, init) => {
      auth = (init?.headers as Record<string, string>).Authorization ?? "";
      expect(url).toBe("http://backend.test/v1/tasks");
      return { status: 201, body: { taskId: "t1", status: "queued" } };
    });
    const r = await createTask({ title: "收集竞赛" });
    expect(r.taskId).toBe("t1");
    expect(auth).toBe("Bearer tok");
  });

  it("getTask 解包 task", async () => {
    mockFetch(() => ({ status: 200, body: { task: { id: "t1", status: "succeeded", usage: { tokens: 5 } } } }));
    const t = await getTask("t1");
    expect(t.status).toBe("succeeded");
  });

  it("listEvents 带 after 参数", async () => {
    mockFetch((url) => { expect(url).toContain("/events?after=3"); return { status: 200, body: { events: [{ seq: 4 }] } }; });
    const ev = await listEvents("t1", 3);
    expect(ev[0].seq).toBe(4);
  });

  it("cancelTask / resumeTask", async () => {
    mockFetch((url) => url.endsWith("/cancel") ? { status: 200, body: { ok: true } } : { status: 200, body: { task: { id: "t1", status: "queued" } } });
    expect(await cancelTask("t1")).toBe(true);
    expect((await resumeTask("t1")).status).toBe("queued");
  });

  it("后端错误可读透传（非 [object Object]）", async () => {
    mockFetch(() => ({ status: 403, body: { error: "forbidden" } }));
    await expect(getTask("t1")).rejects.toThrow(/forbidden/);
  });

  it("未配置 backend → createTask 抛错", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "");
    await expect(createTask({ title: "x" })).rejects.toThrow(/VITE_BACKEND_URL/);
  });
});

describe("task subscription cleanup", () => {
  it("forwards ordered SSE events and resumes progress polling after disconnect without duplicates", async () => {
    vi.useFakeTimers();
    const listeners: Record<string, (event: { data: string }) => void> = {};
    let source!: { onerror: (() => void) | null };
    vi.stubGlobal("EventSource", class {
      onerror: (() => void) | null = null;
      constructor() { source = this; }
      addEventListener(name: string, cb: (event: { data: string }) => void) { listeners[name] = cb; }
      close() {}
    });
    const event = (seq: number) => ({ taskId: "t1", seq, id: seq, type: "tool.called", payload: { name: "web_fetch" }, createdAt: 1 });
    mockFetch(url => url.includes("/events")
      ? { status: 200, body: { events: [event(1), event(2)] } }
      : { status: 200, body: { task: { id: "t1", status: "running" } } });
    const onEvent = vi.fn();
    const sub = subscribeTask("t1", { onEvent });
    await vi.advanceTimersByTimeAsync(0);
    listeners.task_event({ data: JSON.stringify(event(1)) });
    listeners.task_event({ data: JSON.stringify(event(1)) });
    listeners.task_event({ data: JSON.stringify({ ...event(3), taskId: "another-task" }) });
    expect(onEvent).toHaveBeenCalledTimes(1);
    source.onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(onEvent.mock.calls.map(call => call[0].seq)).toEqual([1, 2]);
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith("/events?after=1"))).toBe(true);
    sub.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the ten-minute fallback after normal task completion", async () => {
    vi.useFakeTimers(); vi.stubGlobal("EventSource", undefined);
    mockFetch((url) => url.endsWith("/v1/tasks")
      ? { status: 201, body: { taskId: "t1", status: "queued" } }
      : { status: 200, body: { task: { id: "t1", status: "succeeded" } } });
    const result = runTaskViaBackend({ title: "fixture" });
    await vi.advanceTimersByTimeAsync(0);
    expect((await result).status).toBe("succeeded");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not open SSE or poll after stop during async authentication", async () => {
    vi.useFakeTimers();
    const Source = vi.fn(); vi.stubGlobal("EventSource", Source);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const sub = subscribeTask("t1", {}); sub.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(Source).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
