import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  loadSessions,
  saveSessions,
  newSession,
  type ChatSession,
} from "./sessions";

interface SessionsState {
  sessions: ChatSession[];
  activeId: string;
  setActiveId: (id: string) => void;
  create: () => ChatSession;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  update: (id: string, fn: (s: ChatSession) => ChatSession) => void;
  active: ChatSession;
}

const Ctx = createContext<SessionsState | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const s = loadSessions();
    return s.length ? s : [newSession()];
  });
  const [activeId, setActiveId] = useState(() => sessions[0]?.id);

  useEffect(() => saveSessions(sessions), [sessions]);

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];

  const value: SessionsState = {
    sessions,
    activeId,
    setActiveId,
    active,
    create: () => {
      const s = newSession(active?.mode ?? "auto");
      setSessions((l) => [s, ...l]);
      setActiveId(s.id);
      return s;
    },
    rename: (id, name) => setSessions((l) => l.map((s) => (s.id === id ? { ...s, name } : s))),
    remove: (id) =>
      setSessions((l) => {
        const next = l.filter((s) => s.id !== id);
        const fin = next.length ? next : [newSession()];
        if (id === activeId) setActiveId(fin[0].id);
        return fin;
      }),
    update: (id, fn) => setSessions((l) => l.map((s) => (s.id === id ? fn(s) : s))),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSessions(): SessionsState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSessions must be used within SessionsProvider");
  return v;
}