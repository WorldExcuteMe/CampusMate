// Agent Task API 客户端：前端默认走后端 Task Runtime（AC01）。
// JWT 取自 Supabase session；VITE_BACKEND_URL 配置后端地址。SSE 实时进度 + 轮询回退。
import { supabaseClient } from "@/app/config";
import type { Opportunity } from "@/lib/data/types";

export interface AgentTask {
  id: string; userId: string; title: string; intent: string;
  status: "queued" | "running" | "needs_input" | "paused" | "succeeded" | "failed" | "cancelled";
  usage: { tokens: number; toolCalls: number; wallMs: number; costUsd: number };
  result?: { summary: string; artifactIds: string[]; partial?: boolean };
  error?: string;
}
export interface AgentEvent { id: number; taskId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: number; }

export function backendUrl(): string | null {
  const env = import.meta.env as Record<string, string | undefined>;
  return env.VITE_BACKEND_URL ?? null;
}
export function backendEnabled(): boolean { return Boolean(backendUrl()); }

async function authHeader(): Promise<Record<string, string>> {
  if (!supabaseClient) return {};
  const { data } = await supabaseClient.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const base = backendUrl();
  if (!base) throw new Error("VITE_BACKEND_URL 未配置");
  const headers = { "Content-Type": "application/json", ...(await authHeader()), ...(init?.headers ?? {}) };
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = JSON.parse(text).error ?? text; } catch { /* keep text */ }
    throw new Error(`Backend HTTP ${res.status}: ${detail}`);
  }
  return JSON.parse(text) as T;
}

export async function createTask(input: { title: string; intent?: string; sessionId?: string; images?: string[] }): Promise<{ taskId: string; status: string }> {
  return req("/v1/tasks", { method: "POST", body: JSON.stringify(input) });
}
export async function getTask(id: string): Promise<AgentTask> {
  return (await req<{ task: AgentTask }>(`/v1/tasks/${id}`)).task;
}
export async function listEvents(id: string, after = 0): Promise<AgentEvent[]> {
  return (await req<{ events: AgentEvent[] }>(`/v1/tasks/${id}/events?after=${after}`)).events;
}
export async function cancelTask(id: string): Promise<boolean> {
  return (await req<{ ok: boolean }>(`/v1/tasks/${id}/cancel`, { method: "POST" })).ok;
}
export async function resumeTask(id: string): Promise<AgentTask> {
  return (await req<{ task: AgentTask }>(`/v1/tasks/${id}/resume`, { method: "POST" })).task;
}

// ── 个人上下文：学期 / 课表 ──
export interface Term { id: string; name: string; startDate: string; endDate: string; totalWeeks: number; timezone: string; }
export interface ScheduleRow { id: string; courseName: string; weekday: number; startTime: string; endTime: string; startWeek: number; endWeek: number; weekPattern: "every" | "odd" | "even"; classroom?: string; }

export async function listTerms(): Promise<Term[]> {
  return (await req<{ terms: Term[] }>("/v1/terms")).terms;
}
export async function listSchedules(termId: string): Promise<{ schedules: ScheduleRow[]; exceptions: unknown[] }> {
  return req(`/v1/schedules?termId=${encodeURIComponent(termId)}`);
}
export async function importSchedule(input: { format: string; data: string; termStart: string; totalWeeks: number; termId?: string; confirm?: boolean }): Promise<{ confirmed: boolean; preview: { schedules: ScheduleRow[]; errors: string[]; duplicates: number }; saved?: number }> {
  return req("/v1/schedules/import", { method: "POST", body: JSON.stringify(input) });
}

// ── 机会雷达（后端真相源；Agent 经 save_opportunity 写入）──
export async function listBackendOpportunities(): Promise<Opportunity[]> {
  return (await req<{ opportunities: Opportunity[] }>("/v1/opportunities")).opportunities;
}
export async function getBackendOpportunity(id: string): Promise<Opportunity | null> {
  try { return (await req<{ opportunity: Opportunity }>(`/v1/opportunities/${id}`)).opportunity; }
  catch { return null; }
}
export async function createBackendOpportunity(o: Partial<Opportunity> & { title: string }): Promise<Opportunity> {
  return (await req<{ opportunity: Opportunity }>("/v1/opportunities", { method: "POST", body: JSON.stringify(o) })).opportunity;
}

export interface TaskSubscription { stop: () => void; }

// 订阅任务进度：优先 SSE，失败回退轮询。终态自动停止。
export function subscribeTask(id: string, handlers: { onEvent?: (e: AgentEvent) => void; onStatus?: (t: AgentTask) => void; onClose?: (status: string) => void }): TaskSubscription {
  const base = backendUrl();
  let stopped = false;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const poll = async () => {
    if (stopped) return;
    try {
      const t = await getTask(id);
      handlers.onStatus?.(t);
      if (["succeeded", "failed", "cancelled", "needs_input", "paused"].includes(t.status)) { handlers.onClose?.(t.status); stopped = true; return; }
    } catch { /* 瞬断继续轮询 */ }
    timer = setTimeout(poll, 1500);
  };

  void (async () => {
    const headers = await authHeader();
    const token = (headers.Authorization ?? "").replace(/^Bearer\s+/i, "");
    if (base && typeof EventSource !== "undefined" && token) {
      try {
        es = new EventSource(`${base}/v1/tasks/${id}/stream?token=${encodeURIComponent(token)}`);
        es.addEventListener("task_event", (ev) => { try { handlers.onEvent?.(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore */ } });
        es.addEventListener("task_status", (ev) => { try { const d = JSON.parse((ev as MessageEvent).data); handlers.onStatus?.(d as AgentTask); } catch { /* ignore */ } });
        es.addEventListener("close", (ev) => { try { const d = JSON.parse((ev as MessageEvent).data); handlers.onClose?.(d.status); } catch { /* ignore */ } stopped = true; es?.close(); });
        es.onerror = () => { es?.close(); es = null; if (!stopped) void poll(); }; // SSE 失败 → 轮询回退
        return;
      } catch { es = null; }
    }
    void poll();
  })();

  return { stop: () => { stopped = true; es?.close(); if (timer) clearTimeout(timer); } };
}

// 提交任务并等待终态（聊天式一次性调用）。返回最终任务。
export async function runTaskViaBackend(input: { title: string; intent?: string; sessionId?: string; images?: string[] }, onProgress?: (t: AgentTask) => void): Promise<AgentTask> {
  const { taskId } = await createTask(input);
  return await new Promise<AgentTask>((resolve, reject) => {
    const sub = subscribeTask(taskId, {
      onStatus: (t) => onProgress?.(t),
      onClose: async () => { sub.stop(); try { resolve(await getTask(taskId)); } catch (e) { reject(e); } },
    });
    // 兜底超时（10 分钟），避免悬挂。
    setTimeout(() => { sub.stop(); void getTask(taskId).then(resolve).catch(reject); }, 600000);
  });
}