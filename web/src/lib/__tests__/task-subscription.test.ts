import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/app/config", () => ({ supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: "fixture-token" } } }) } } }));
import { subscribeTask } from "../agent/api-client";
class FakeSource extends EventTarget {
  static instances: FakeSource[] = [];
  url: string; closed = false; onerror: (() => void) | null = null; onopen: (() => void) | null = null;
  constructor(url: string) { super(); this.url = url; FakeSource.instances.push(this); }
  close() { this.closed = true; }
  emit(type: string, value: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value) })); }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); FakeSource.instances = []; });
it("SSE乱序/重复，断线poll补事件并携cursor重连，终态补齐后只关闭一次", async () => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_BACKEND_URL", "http://backend.test"); vi.stubGlobal("EventSource", FakeSource);
  const received: number[] = []; let terminal = false;
  const event = (seq: number) => ({ id: seq, taskId: "t1", seq, type: "tool.called", payload: { name: "web_search" }, createdAt: seq });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const after = Number(new URL(url).searchParams.get("after") ?? 0);
    const body = url.includes("/events?") ? { events: after < 3 ? [event(1), event(2), event(3)] : after < 4 ? [event(4)] : terminal ? [event(5), event(6)] : [] } : { task: { id: "t1", status: terminal ? "succeeded" : "running", usage: {} } };
    return { ok: true, text: async () => JSON.stringify(body) };
  }));
  const close = vi.fn();
  const sub = subscribeTask("t1", { onEvent: (e) => received.push(e.seq), onClose: close }, { pollMs: 5, reconnectMs: 10 });
  await vi.advanceTimersByTimeAsync(0);
  expect(FakeSource.instances).toHaveLength(1);
  const first = FakeSource.instances[0]; first.onopen?.();
  first.emit("task_event", event(2));
  await vi.advanceTimersByTimeAsync(0);
  expect(received).toEqual([1, 2, 3]);
  first.emit("task_event", event(2)); first.onerror?.();
  await vi.advanceTimersByTimeAsync(10);
  expect(received).toContain(4);
  expect(FakeSource.instances.length).toBeGreaterThan(1);
  const resumed = FakeSource.instances.at(-1)!;
  expect(resumed.url).toContain("after=4"); resumed.onopen?.();
  terminal = true;
  resumed.emit("task_status", { id: "t1", status: "succeeded", usage: {} });
  await vi.advanceTimersByTimeAsync(0);
  expect(close).toHaveBeenCalledTimes(1);
  expect(received).toEqual([1, 2, 3, 4, 5, 6]);
  sub.stop(); first.emit("task_event", event(7));
  expect(received).not.toContain(7);
});
