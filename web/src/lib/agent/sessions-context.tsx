import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  loadSessions,
  saveSessions,
  newSession,
  backendSessionId,
  type ChatSession,
} from "./sessions";
import { useAuth } from "@/app/auth";
import { backendEnabled } from './api-client';
import { useCloudSessions } from './use-cloud-sessions';
import { ComposerDraftStore } from './composer-drafts';
import { ComposerDraftsProvider } from './composer-drafts-context';

interface SessionsState {
  sessions: ChatSession[];
  activeId: string;
  setActiveId: (id: string) => void;
  create: () => ChatSession;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  archive: (id: string) => void;
  restore: (id: string) => void;
  update: (id: string, fn: (s: ChatSession) => ChatSession) => void;
  active: ChatSession;
  storageError: string | null;
  syncError: string | null;
  syncing: boolean;
  initialLoading: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  refresh: () => void;
  changeMode: (id: string, mode: 'auto' | 'daily') => void;
}

const Ctx = createContext<SessionsState | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const owner = session?.user.id ?? "demo";
  return <OwnerSessionsProvider key={owner} owner={owner}>{children}</OwnerSessionsProvider>;
}

function OwnerSessionsProvider({ children, owner }: { children: ReactNode; owner: string }) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const s = loadSessions(owner);
    return s.length ? s : [newSession()];
  });
  const activeKey = `campusmate.active-session.v1:${encodeURIComponent(owner)}`;
  const [activeId, setActiveId] = useState(() => { try { const old = localStorage.getItem(activeKey); return sessions.find(s => s.id === old)?.id ?? sessions[0]?.id; } catch { return sessions[0]?.id; } });
  const ids = useRef(new Set(sessions.map(s => s.id))); ids.current = new Set(sessions.map(s => s.id));
  const latestSessions = useRef(sessions); latestSessions.current = sessions;
  const [drafts] = useState(() => new ComposerDraftStore(owner, id => ids.current.has(id), (id, hasDraft) => setSessions(list => list.map(s => s.id === id && Boolean(s.hasDraft) !== hasDraft ? { ...s, hasDraft } : s)), undefined, undefined,
    id => latestSessions.current.find(s => s.id === id)?.backendId ?? (backendEnabled() && owner !== 'demo' ? backendSessionId(owner, id) : id)));
  const previousSessions = useRef(sessions);
  const [storageError, setStorageError] = useState<string | null>(null);
  const cloudEnabled = backendEnabled() && owner !== 'demo';
  const cloud = useCloudSessions({ enabled: cloudEnabled, owner, sessions, setSessions, activeId, setActiveId });

  useEffect(() => { setStorageError(saveSessions(sessions, owner) ? null : "浏览器存储已满或不可用，本次本地记录可能无法在刷新后保留；后台任务继续运行。"); }, [sessions, owner]);
  useEffect(() => { for (const s of previousSessions.current) if (!ids.current.has(s.id)) drafts.remove(s.id, s.backendId); previousSessions.current = sessions; }, [sessions, drafts]);
  useEffect(() => { try { localStorage.setItem(activeKey, activeId); } catch { /* storage warning already shown above */ } }, [activeKey, activeId]);

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];

  const value: SessionsState = {
    sessions,
    activeId,
    setActiveId,
    active,
    storageError,
    syncError: cloud.error,
    syncing: cloud.syncing,
    initialLoading: cloud.initialLoading,
    loadingOlder: cloud.loadingOlder,
    loadOlder: () => { void cloud.loadOlder(activeId); },
    refresh: cloud.refresh,
    changeMode: (id, mode) => setSessions(list => list.map(s => s.id === id ? { ...s, mode } : s)),
    create: () => {
      const preset = localStorage.getItem("campusmate.defaultMode");
      const mode = preset === "daily" || preset === "auto" ? preset : (active?.mode ?? "auto");
      const s = newSession(mode);
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
    archive: (id) =>
      setSessions((l) => {
        const next = l.map((s) => (s.id === id ? { ...s, archived: true } : s));
        if (id === activeId) {
          const vis = next.find((s) => !s.archived);
          if (vis) setActiveId(vis.id);
        }
        return next;
      }),
    restore: (id) => setSessions((l) => l.map((s) => (s.id === id ? { ...s, archived: false } : s))),
    update: (id, fn) => setSessions((l) => l.map((s) => (s.id === id ? fn(s) : s))),
    ...(cloudEnabled ? cloud.actions : {}),
  };
  return <Ctx.Provider value={value}><ComposerDraftsProvider store={drafts}>{children}</ComposerDraftsProvider></Ctx.Provider>;
}

export function useSessions(): SessionsState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSessions must be used within SessionsProvider");
  return v;
}
