export interface SessionMsg {
  role: "user" | "assistant";
  content: string;
  actions?: string[];
  mock?: boolean;
  failed?: boolean;
  taskId?: string;
  turnId?: string;
}

export interface ChatSession {
  id: string;
  name: string;
  mode: "auto" | "daily";
  createdAt: string;
  messages: SessionMsg[];
  tokens: number;
  contextUsed?: number;
  contextCap?: number;
  compressed?: boolean;
  pruned?: boolean;
  archived?: boolean;
  backendId?: string;
  pendingTurn?: { turnId: string; content: string; images?: string[]; taskId?: string; providerId?: string; reasoning?: "auto" | "low" | "medium" | "high" };
  promptSource?: "estimated" | "reported" | "unknown";
  actualModel?: string;
  configuredModel?: string;
  currentTaskId?: string;
  taskViews?: Record<string, { task: import("./api-client").AgentTask; events: import("./api-client").AgentEvent[]; lastSeq: number; draft?: string; connection?: string }>;
  taskTokenUsage?: Record<string, number>;
}

const KEY = "campusmate.sessions.v1";

const ownerKey = (owner: string) => `campusmate.sessions.v2:${encodeURIComponent(owner)}`;
export function loadSessions(owner = "demo"): ChatSession[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ownerKey(owner)) ?? (owner === "demo" ? localStorage.getItem(KEY) : null) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSessions(list: ChatSession[], owner = "demo"): boolean {
  try { localStorage.setItem(ownerKey(owner), JSON.stringify(list)); return true; } catch { return false; }
}

export function backendSessionId(owner: string, localId: string): string {
  const key = `campusmate.session-map.v1:${encodeURIComponent(owner)}:${encodeURIComponent(localId)}`;
  const old = localStorage.getItem(key);
  if (old) return old;
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

export function newSession(mode: "auto" | "daily" = "auto"): ChatSession {
  return {
    id: crypto.randomUUID(),
    name: "新会话",
    mode,
    createdAt: new Date().toISOString(),
    messages: [],
    tokens: 0,
  };
}

export function autoName(text: string): string {
    const t = text.replace(/\s+/g, " ").trim();
  return t.length > 18 ? t.slice(0, 18) + "…" : t || "新会话";
}
