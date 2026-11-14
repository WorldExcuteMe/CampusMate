import { useCallback, useEffect, useState } from "react";
import { backendEnabled, listSessionTasks, subscribeTask } from "@/lib/agent/api-client";
import type { ChatSession } from "@/lib/agent/sessions";
import { mergeEvent, mergeTask } from "@/lib/agent/task-state";
import { errorMessage } from "@/lib/llm/errors";

export function useTaskMonitor(active: ChatSession, update: (id: string, fn: (s: ChatSession) => ChatSession) => void, sending: boolean) {
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    if (!sending) {
      const local = Object.values(active.taskViews ?? {}).filter((v) => v.task.id.startsWith("local:") && ["queued", "running"].includes(v.task.status));
      if (local.length) update(active.id, (session) => local.reduce((s, view) => mergeTask(s, { ...view.task, status: "failed", result: { summary: "浏览器执行已中断，已有记录保留，请用新消息继续。", artifactIds: [], partial: true } }), session));
    }
    if (!backendEnabled() || !active.backendId || sending) return;
    let disposed = false; let subscription: ReturnType<typeof subscribeTask> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const id = active.id, sessionId = active.backendId;
    const load = async (initial: boolean) => {
      try {
        const tasks = await listSessionTasks(sessionId);
        if (disposed) return;
        setError("");
        const selected = tasks.find((task) => task.id === active.currentTaskId) ?? tasks[0];
        update(id, (session) => tasks.reduce((s, task) => mergeTask(s, task), session));
        if (selected && initial) subscription = subscribeTask(selected.id, {
          onEvent: (event) => { if (!disposed) update(id, (session) => mergeEvent(session, event)); },
          onStatus: (task) => { if (!disposed) update(id, (session) => mergeTask(session, task)); },
          onConnection: (connection) => { if (!disposed) update(id, (session) => { const view = session.taskViews?.[selected.id]; return view ? { ...session, taskViews: { ...session.taskViews, [selected.id]: { ...view, connection } } } : session; }); },
        }, { afterSeq: active.taskViews?.[selected.id]?.lastSeq ?? 0 });
        if (tasks.some((task) => task.id !== selected?.id && ["queued", "running"].includes(task.status))) timer = setTimeout(() => { void load(false); }, 5000);
      } catch (err) { if (!disposed) { setError(errorMessage(err)); timer = setTimeout(() => { void load(initial); }, 5000); } }
    };
    void load(true);
    return () => { disposed = true; subscription?.stop(); if (timer) clearTimeout(timer); };
    // Updating the local event cache must not create another subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id, active.backendId, active.currentTaskId, sending, version]);
  return { error, refresh };
}
