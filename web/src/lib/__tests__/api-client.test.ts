import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// mock config：supabaseClient 提供 session token；backendUrl 经 import.meta.env。
vi.mock("@/app/config", () => ({ isCloudRuntime: false,
  supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
}));

import { createTask, ensureSession, getTask, cancelTask, resumeTask, listEvents, backendEnabled } from "../agent/api-client";

beforeEach(() => {
  vi.stubEnv("VITE_BACKEND_URL", "http://backend.test");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

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
  it("会话映射仅上传元数据，新turn请求带稳定ID和当前输入，无旧聊天", async () => {
    const bodies: unknown[] = [];
    mockFetch((url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return url.endsWith("/sessions") ? { status: 201, body: { session: { id: "uuid-session" } } } : { status: 201, body: { taskId: "t1" } };
    });
    const id = await ensureSession({ id: "uuid-session", title: "旧会话", mode: "auto" });
    await createTask({ title: "新问题", intent: "推荐竞赛", sessionId: id, turnId: "stable-turn" });
    expect(bodies).toEqual([{ id: "uuid-session", title: "旧会话", mode: "auto" }, { title: "新问题", intent: "推荐竞赛", sessionId: id, turnId: "stable-turn" }]);
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
