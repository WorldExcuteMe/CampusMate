export interface SessionMsg {
  role: "user" | "assistant";
  content: string;
  actions?: string[];
  mock?: boolean;
  failed?: boolean;
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
}

const KEY = "campusmate.sessions.v1";

export function loadSessions(scope = "demo"): ChatSession[] {
  try {
    return JSON.parse(localStorage.getItem(`${KEY}.${encodeURIComponent(scope)}`) ?? (scope === "demo" ? localStorage.getItem(KEY) : null) ?? "[]") as ChatSession[];
  } catch {
    return [];
  }
}

export function saveSessions(list: ChatSession[], scope = "demo"): void {
  localStorage.setItem(`${KEY}.${encodeURIComponent(scope)}`, JSON.stringify(list));
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