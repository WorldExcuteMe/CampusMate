import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { backendSessionId, newSession, type ChatSession } from './sessions';
import { createRemoteSession, getRemoteHistory, hydrateSession, importRemoteHistory, listRemoteSessions, patchRemoteSession, removeRemoteSession, unmatchedMessages, type RemoteSession } from './session-sync';
import { toast } from 'sonner';
import { getHistoryPage, getHistoryChanges, mergeHistoryPage } from './session-sync';

export function useCloudSessions({ enabled, owner, sessions, setSessions, activeId, setActiveId }: { enabled: boolean; owner: string; sessions: ChatSession[]; setSessions: Dispatch<SetStateAction<ChatSession[]>>; activeId: string; setActiveId: Dispatch<SetStateAction<string>> }) {
  const cache = useRef(sessions); cache.current = sessions;
  const selected = useRef(activeId); selected.current = activeId;
  const remoteMap = useRef(new Map<string, RemoteSession>());
  const alive = useRef(true), ready = useRef(!enabled), writes = useRef(0), queue = useRef(Promise.resolve());
  const refreshRef = useRef<() => void>(() => {});
  const [initialLoading, setInitialLoading] = useState(enabled);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [olderId,setOlderId] = useState<string|null>(null);
  const olderFlight=useRef(false);
  const olderController=useRef<AbortController|null>(null);
  const remember = (remote: RemoteSession) => { const old = remoteMap.current.get(remote.id); if (!old || (remote.revision ?? 0) >= (old.revision ?? 0)) remoteMap.current.set(remote.id, remote); };
  const resolveId = (s: ChatSession) => s.backendId ?? backendSessionId(owner, s.id);
  function applyMetadata(remote: RemoteSession, localId?: string) {
    remember(remote);
    setSessions(list => {
      const next = list.filter(s => !remote.deletedAt || !(s.id === localId || s.backendId === remote.id));
      if (!remote.deletedAt) return next.map(s => s.id === localId || s.backendId === remote.id ? hydrateSession(remote, s) : s);
      if (next.length) return next;
      return [newSession()];
    });
  }
  async function ensure(s: ChatSession) {
    const id = resolveId(s), known = remoteMap.current.get(id);
    if (known?.deletedAt) throw new Error('会话已在其他窗口删除，请新建会话');
    if (known) return known;
    const remote = await createRemoteSession({ id, title: s.name, mode: s.mode }, owner);
    if (!alive.current) return remote;
    remember(remote); applyMetadata(remote, s.id); return remote;
  }
  function enqueue(work: () => Promise<void>) {
    if (!alive.current) return;
    if (!ready.current) { setError('正在恢复会话，请稍候再操作。'); return; }
    writes.current++; setSyncing(true);
    queue.current = queue.current.catch(() => {}).then(async () => { if (alive.current) await work(); }).catch(e => { if (alive.current) { const text = `会话同步未完成：${e instanceof Error ? e.message : String(e)}；本地记录已保留。`; setError(text); toast.error(text); } }).finally(() => { writes.current--; if (alive.current && !writes.current) { setSyncing(false); refreshRef.current(); } });
  }
  const patch = (id: string, fields: { title?: string; archived?: boolean; mode?: 'auto' | 'daily' }) => enqueue(async () => {
    const s = cache.current.find(s => s.id === id); if (!s) return;
    const remote = await ensure(s); if (!alive.current) return;
    const saved = await patchRemoteSession(remote.id, { ...fields, expectedRevision: s.remoteRevision ?? remote.revision ?? 0 }, owner);
    if (alive.current) { applyMetadata(saved, s.id); setError(null); }
  });
  useEffect(() => {
    if (!enabled) { ready.current = true; setInitialLoading(false); return; }
    alive.current = true; let stopped = false, inFlight = false, again = false;
    let controller: AbortController | undefined;
    const migrated = new Set<string>();
    const refresh = async () => {
      if (stopped) return;
      if (inFlight || writes.current) { again = true; return; }
      inFlight = true; again = false; controller = new AbortController();
      try {
        // Preserve the pre-sync cache once, including browser-only legacy history.
        const backup = `campusmate.sessions.before-cloud.v1:${encodeURIComponent(owner)}`;
        if (!localStorage.getItem(backup) && cache.current.some(s => s.messages.length && s.remoteRevision===undefined)) localStorage.setItem(backup, JSON.stringify(cache.current));
        let remotes = await listRemoteSessions(controller.signal, owner); if (stopped) return;
        for (const r of remotes) remember(r);
        for (const local of [...cache.current]) {
          if (stopped) return;
          const id = resolveId(local); let remote = remoteMap.current.get(id);
          if (remote?.deletedAt || migrated.has(local.id) || local.remoteRevision !== undefined && !local.remotePending) continue;
          if (!remote && !local.messages.length && !local.remotePending && local.name === '新会话' && !local.archived) continue;
          if (!remote) remote = await createRemoteSession({ id, title: local.name, mode: local.mode }, owner);
          if (stopped) return;
          const history = await getRemoteHistory(id, controller.signal, owner);
          const legacy = unmatchedMessages(local, history);
          if (legacy.length) await importRemoteHistory(id, legacy, owner);
          // Upgrade old local-only names/archives once, never overwrite an
          // already versioned metadata change made by another browser.
          if ((remote.revision ?? 0) === 0 && (remote.title !== local.name || remote.mode !== local.mode || Boolean(remote.archived) !== Boolean(local.archived))) remote = await patchRemoteSession(id, { title: local.name, mode: local.mode, archived: Boolean(local.archived), expectedRevision: 0 }, owner);
          remember(remote); migrated.add(local.id);
        }
        remotes = [...remoteMap.current.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
        if (stopped || writes.current) { again = true; return; }
        let target: ChatSession | undefined;
        setSessions(list => {
          const byRemote = new Map(list.map(s => [resolveId(s), s]));
          const next: ChatSession[] = remotes.filter(r => !r.deletedAt).map(r => { const s=hydrateSession(r,byRemote.get(r.id)); return s.remotePending ? {...s,remotePending:false}:s; });
          for (const local of list) if (!remoteMap.current.has(resolveId(local)) && (!remotes.some(r => !r.deletedAt && !r.archived) || local.hasDraft || local.messages.length || local.remotePending || local.name !== '新会话' || local.archived)) next.push(local);
          if (!next.length) next.push(newSession());
          const current = next.find(s => s.id === selected.current);
          const previous = list.find(s => s.id === selected.current);
          const emptyPlaceholder = current && !current.backendId && !current.hasDraft && !current.messages.length && !current.remotePending && current.name === '新会话';
          target = current && !(current.archived && !previous?.archived) && !emptyPlaceholder ? current : next.find(s => s.backendId && !s.archived) ?? current ?? next.find(s => !s.archived) ?? next[0];
          if (target && target.id !== selected.current) { selected.current = target.id; setActiveId(target.id); }
          cache.current = next; return list.length===next.length && next.every((s,i)=>s===list[i]) ? list : next;
        });
        // React may defer state setters; choose the latest currently selected
        // remote target independently, then merge the fetched snapshot functionally.
        const chosen = cache.current.find(s => s.id === selected.current);
        const remoteId = chosen?.backendId ?? target?.backendId ?? remotes.find(r => !r.deletedAt && !r.archived)?.id;
        if (remoteId && !remoteMap.current.get(remoteId)?.deletedAt) {
          let known=cache.current.find(s=>s.backendId===remoteId)?.historyPage;
          let history;
          try { history=known ? await getHistoryChanges(remoteId,known.after,known.next,controller.signal,owner) : await getHistoryPage(remoteId,undefined,controller.signal,owner); }
          catch(e) { if(!known || !String(e).includes('游标'))throw e; known=undefined;history=await getHistoryPage(remoteId,undefined,controller.signal,owner); }
          if (stopped || writes.current) { again = true; return; }
          remember(history.session);
          if (remoteMap.current.get(remoteId)?.deletedAt) return;
          setSessions(list => { let changed=false; const next=list.map(s=> { if (s.backendId!==remoteId) return s; const merged=mergeHistoryPage(s,history,known?'changes':'initial'); if (merged!==s) changed=true; return merged; }); return changed?next:list; });
        }
        if (!stopped) setError(null);
      } catch (e) { if (!stopped) setError(`会话同步未完成：${e instanceof Error ? e.message : String(e)}；本地缓存保留，可重试。`); }
      finally { inFlight = false; if (!stopped) { ready.current = true; setInitialLoading(false); if (again && !writes.current) queueMicrotask(() => { void refresh(); }); } }
    };
    refreshRef.current = () => { void refresh(); };
    void refresh(); const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 5000);
    const focus = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { stopped = true; alive.current = false; controller?.abort(); olderController.current?.abort(); clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
    // State updates are read through refs; never restart polling per token/event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, owner]);
  async function loadOlder(id:string) {
    const s=cache.current.find(s=>s.id===id); if (!enabled || !s?.backendId || !s.historyPage?.hasMore || !s.historyPage.before || olderFlight.current) return;
    olderFlight.current=true; setOlderId(id);
    const controller=new AbortController();olderController.current=controller;
    try {
      const page=await getHistoryPage(s.backendId,s.historyPage.before,controller.signal,owner);
      if (!alive.current || remoteMap.current.get(s.backendId)?.deletedAt) return;
      setSessions(list=>list.map(current=>current.id===id?mergeHistoryPage(current,page,'older'):current)); setError(null);
    } catch(e) { if(alive.current) { const text=`更早消息未能加载：${e instanceof Error?e.message:String(e)}；现有记录已保留，可重试。`;setError(text);toast.error(text); } }
    finally { olderFlight.current=false;if(olderController.current===controller)olderController.current=null;if(alive.current)setOlderId(null); }
  }
  return { initialLoading, syncing, error, loadingOlder:olderId===activeId, loadOlder, refresh: () => refreshRef.current(), actions: {
    setActiveId: (id: string) => { selected.current = id; setActiveId(id); refreshRef.current(); },
    create: () => { const s = newSession(cache.current.find(s => s.id === selected.current)?.mode ?? 'auto'); s.remotePending = true; setSessions(list => [s, ...list]); selected.current = s.id; setActiveId(s.id); enqueue(async () => { const remote = await ensure(s); if (alive.current) applyMetadata(remote, s.id); }); return s; },
    rename: (id: string, title: string) => patch(id, { title }),
    archive: (id: string) => patch(id, { archived: true }),
    restore: (id: string) => patch(id, { archived: false }),
    changeMode: (id: string, mode: 'auto' | 'daily') => patch(id, { mode }),
    remove: (id: string) => enqueue(async () => { const s = cache.current.find(s => s.id === id); if (!s) return; const remote = await ensure(s); if (!alive.current) return; const saved = await removeRemoteSession(remote.id, remote.revision ?? 0, owner); if (alive.current) { applyMetadata(saved, s.id); setError(null); } }),
  } };
}
