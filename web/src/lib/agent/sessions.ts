export interface SessionMsg {
  role: "user" | "assistant";
  content: string;
  actions?: string[];
  mock?: boolean;
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
}

const KEY = "campusmate.sessions.v1";

export function loadSessions(): ChatSession[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]") as ChatSession[];
  } catch {
    return [];
  }
}

export function saveSessions(list: ChatSession[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function newSession(mode: "auto" | "daily" = "auto"): ChatSession {
  return {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
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