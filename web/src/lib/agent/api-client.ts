// Agent Task API 客户端：前端默认走后端 Task Runtime（AC01）。
// JWT 取自 Supabase session；VITE_BACKEND_URL 配置后端地址。SSE 实时进度 + 轮询回退。
import { supabaseClient } from "@/app/config";
import type { Opportunity } from "@/lib/data/types";

export interface AgentTask {
  id: string; userId: string; title: string; intent?: string;
  status: "queued" | "running" | "needs_input" | "paused" | "succeeded" | "failed" | "cancelled";
  usage: { tokens: number; toolCalls: number; wallMs: number; costUsd: number };
  result?: { summary: string; artifactIds: string[]; partial?: boolean; completion?: { state: "complete" | "partial"; reason: string; checks?: { id: string; passed: boolean; detail?: string }[] } };
  error?: string;
  sessionId?: string; turnId?: string;
  turnSeq?: number; createdAt?: number; updatedAt?: number; cancelRequested?: boolean;
  budget?: { tokens: number; toolCalls: number; wallMs: number; costUsd: number };
  promptUsage?: { inputTokens: number | null; contextLimit: number | null; outputReserve: number; source: "reported" | "estimated" | "unknown" };
  modelConfig?: { providerId: string; displayName: string; modelId: string; contextLimit: number | null };
  modelRuntime?: { actualModel: string; providerId?: string; lastRequest?: { attempts: number; ttftMs: number | null; totalMs: number; reasoning: { requested: string; effective: string | null; reason: string }; usage: { cacheRead: number | null; inputTotal: number | null; output: number | null; reasoning: number | null; costUsd: number | null } } };
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

export async function req<T>(path: string, init?: RequestInit): Promise<T> {
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

export interface TaskInput { title: string; intent?: string; sessionId?: string; turnId?: string; images?: string[]; providerId?: string; reasoning?: "auto" | "low" | "medium" | "high"; }
export async function createTask(input: TaskInput): Promise<{ taskId: string; status: string }> {
  return req("/v1/tasks", { method: "POST", body: JSON.stringify(input) });
}
export async function ensureSession(input: { id: string; title: string; mode: "auto" | "daily" }): Promise<string> {
  return (await req<{ session: { id: string } }>("/v1/sessions", { method: "POST", body: JSON.stringify(input) })).session.id;
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
export async function resumeTask(id: string, budget?: AgentTask["budget"]): Promise<AgentTask> {
  return (await req<{ task: AgentTask }>(`/v1/tasks/${id}/resume`, { method: "POST", body: JSON.stringify({ budget }) })).task;
}
export async function listSessionTasks(sessionId: string): Promise<AgentTask[]> { return (await req<{ tasks: AgentTask[] }>(`/v1/sessions/${encodeURIComponent(sessionId)}/tasks`)).tasks; }
export interface TaskApproval { id: string; taskId: string; toolName: string; risk: string; status: string; }
export async function listApprovals(): Promise<TaskApproval[]> { return (await req<{ approvals: TaskApproval[] }>("/v1/approvals")).approvals; }
export async function decideApproval(id: string, decision: "approved" | "rejected"): Promise<void> { await req(`/v1/approvals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ decision }) }); }

// ── 个人上下文：学期 / 课表 ──
export interface Term { id: string; institutionId?: string; name: string; startDate: string; endDate: string; totalWeeks: number; timezone: string; weekAnchor?: string; }
export interface ScheduleRow { id: string; courseId?: string; courseName: string; weekday: number; startTime: string; endTime: string; startWeek: number; endWeek: number; weekPattern: "every" | "odd" | "even"; classroom?: string; campus?: string; }
export type { CourseException, TimeScheme } from "../../../../shared/calendar";
import type { CourseException, TimeScheme } from "../../../../shared/calendar";
export interface SchedulePreview { schedules: Omit<ScheduleRow, "id">[]; errors: string[]; duplicates: number; conflicts: { a: Pick<ScheduleRow, "courseName">; b: Pick<ScheduleRow, "courseName"> }[]; }
export interface ScheduleImportResult { confirmed: boolean; jobId: string; preview: SchedulePreview; saved?: number; }

export async function listTerms(): Promise<Term[]> {
  return (await req<{ terms: Term[] }>("/v1/terms")).terms;
}
export async function listSchedules(termId: string): Promise<{ schedules: ScheduleRow[]; exceptions: CourseException[]; schemes: TimeScheme[] }> {
  return req(`/v1/schedules?termId=${encodeURIComponent(termId)}`);
}
export async function importSchedule(input: { format?: string; data?: string; encoding?: "base64"; sourceName?: string; termId?: string; confirm?: boolean; jobId?: string; allowPartial?: boolean }): Promise<ScheduleImportResult> {
  return req("/v1/schedules/import", { method: "POST", body: JSON.stringify(input) });
}
export async function createTerm(input: Omit<Term, "id">): Promise<Term> { return (await req<{ term: Term }>("/v1/terms", { method: "POST", body: JSON.stringify(input) })).term; }
export async function saveTimeScheme(input: TimeScheme): Promise<TimeScheme> { return (await req<{ scheme: TimeScheme }>("/v1/timetable-schemes", { method: "POST", body: JSON.stringify(input) })).scheme; }

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
export interface TaskHandlers {
  onEvent?: (event: AgentEvent) => void; onStatus?: (task: AgentTask) => void;
  onClose?: (status: string) => void; onConnection?: (state: "connecting" | "live" | "polling" | "offline" | "closed") => void;
}
export function subscribeTask(id: string, handlers: TaskHandlers, options: { afterSeq?: number; pollMs?: number; reconnectMs?: number } = {}): TaskSubscription {
  const base = backendUrl(), pending = new Map<number, AgentEvent>();
  let stopped = false, live = false, polling = false, finishing = false, seq = options.afterSeq ?? 0;
  let source: EventSource | null = null, timer: ReturnType<typeof setTimeout> | null = null, reconnect: ReturnType<typeof setTimeout> | null = null;
  let syncing: Promise<void> | null = null;
  const connection = (state: Parameters<NonNullable<TaskHandlers["onConnection"]>>[0]) => { if (!stopped) handlers.onConnection?.(state); };
  const stop = () => { stopped = true; source?.close(); source = null; if (timer) clearTimeout(timer); if (reconnect) clearTimeout(reconnect); };
  const receive = (events: AgentEvent[], repair = true) => {
    if (stopped) return;
    for (const event of events) if (Number.isSafeInteger(event.seq) && event.seq > seq && event.taskId === id) pending.set(event.seq, event);
    while (pending.has(seq + 1)) { const event = pending.get(seq + 1)!; pending.delete(++seq); handlers.onEvent?.(event); if (stopped) return; }
    if (repair && pending.size) void syncEvents().catch(() => { startPoll(); });
  };
  const syncEvents = (): Promise<void> => {
    if (syncing) return syncing;
    syncing = listEvents(id, seq).then((events) => receive(events, false)).finally(() => { syncing = null; });
    return syncing;
  };
  const terminal = (status: string) => ["succeeded", "failed", "cancelled", "needs_input", "paused"].includes(status);
  const finish = async () => {
    if (stopped || finishing) return;
    finishing = true;
    try {
      await syncEvents();
      const task = await getTask(id);
      if (stopped) return;
      handlers.onStatus?.(task);
      if (!terminal(task.status)) { startPoll(); return; }
      await syncEvents();
      if (pending.size) throw new Error("事件尚未补齐");
      if (stopped) return;
      connection("closed"); stop(); handlers.onClose?.(task.status);
    } catch { connection("offline"); startPoll(); }
    finally { finishing = false; }
  };
  const schedulePoll = () => { if (!stopped && !live && !timer) timer = setTimeout(() => { timer = null; void poll(); }, options.pollMs ?? 1500); };
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const [, task] = await Promise.all([syncEvents(), getTask(id)]);
      if (stopped) return;
      connection("polling"); handlers.onStatus?.(task);
      if (terminal(task.status)) { await finish(); return; }
      if (!reconnect && base && typeof EventSource !== "undefined") reconnect = setTimeout(() => { reconnect = null; void connect(); }, options.reconnectMs ?? 5000);
    } catch { connection("offline"); }
    finally { polling = false; schedulePoll(); }
  };
  const startPoll = () => { live = false; void poll(); };
  const connect = async () => {
    if (stopped || live) return;
    connection("connecting");
    const headers = await authHeader();
    if (stopped) return;
    const token = (headers.Authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!base || typeof EventSource === "undefined" || !token) { startPoll(); return; }
    source?.close();
    const current = new EventSource(base + "/v1/tasks/" + encodeURIComponent(id) + "/stream?token=" + encodeURIComponent(token) + "&after=" + seq);
    source = current;
    schedulePoll(); // A stalled initial SSE connection must not hide task progress.
    current.onopen = () => { if (!stopped && source === current) { live = true; if (timer) { clearTimeout(timer); timer = null; } connection("live"); } };
    current.addEventListener("task_event", (ev) => { if (stopped || source !== current) return; try { receive([JSON.parse((ev as MessageEvent).data)]); } catch { startPoll(); } });
    current.addEventListener("task_status", (ev) => { if (stopped || source !== current) return; try { const task = JSON.parse((ev as MessageEvent).data) as AgentTask; handlers.onStatus?.(task); if (terminal(task.status)) void finish(); } catch { startPoll(); } });
    current.addEventListener("close", () => { if (stopped || source !== current) return; current.close(); source = null; live = false; void finish(); });
    current.onerror = () => { if (stopped || source !== current) return; current.close(); source = null; startPoll(); };
  };
  void connect().catch(() => startPoll());
  return { stop };
}

// 提交任务并等待终态（聊天式一次性调用）。返回最终任务。
export async function runTaskViaBackend(input: TaskInput, onProgress?: (t: AgentTask) => void, options: { signal?: AbortSignal; onAccepted?: (id: string) => void; onEvent?: (event: AgentEvent) => void; onConnection?: TaskHandlers["onConnection"] } = {}): Promise<AgentTask> {
  if (options.signal?.aborted) throw new DOMException("已离开会话", "AbortError");
  const { taskId } = await createTask(input);
  options.onAccepted?.(taskId);
  return await new Promise<AgentTask>((resolve, reject) => {
    const done = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); sub.stop(); };
    const abort = () => { done(); reject(new DOMException("已离开会话", "AbortError")); };
    const sub = subscribeTask(taskId, {
      onEvent: options.onEvent,
      onConnection: options.onConnection,
      onStatus: (t) => onProgress?.(t),
      onClose: async () => { done(); try { resolve(await getTask(taskId)); } catch (e) { reject(e); } },
    });
    const timer = setTimeout(() => { done(); reject(new Error("等待超时，任务仍保留在后台，可稍后查看")); }, 600000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
