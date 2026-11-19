import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Send, Bot, Pencil, Loader2, FolderOpen, Paperclip, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useRepository } from "@/app/auth";
import { runChat } from "@/lib/agent/chat";
import { backendEnabled, runTaskViaBackend, ensureSession, getLocalWorkspace, setLocalWorkspacePermission, type ReasoningPreference } from "@/lib/agent/api-client";
import { localWorkspaceIdentity } from "@/lib/agent/local-workspace";
import { errorMessage } from "@/lib/llm/errors";
import { listProviders, type ProviderPublic, type ChatMessage } from "@/lib/llm/proxy";
import { useSessions } from "@/lib/agent/sessions-context";
import { autoName, backendSessionId } from "@/lib/agent/sessions";
import { useAuth } from "@/app/auth";
import { MockBadge } from "@/components/shared";
import { resolveContextCap } from "@/lib/agent/context";
import { SetupWizard } from "./SetupWizard";
import { useComposerDraft } from '@/lib/agent/composer-drafts-context';
import { mergeTask, mergeEvent } from "@/lib/agent/task-state";
import { useTaskMonitor } from "./use-task-monitor";
import { TaskWorkspace } from "./TaskWorkspace";
import { ChatMessageRow } from './ChatMessageRow';
import { AgentActivityCard } from "./AgentActivityCard";
import { ContextUsage } from "./ContextUsage";
import type { AgentActivity } from "@/lib/agent/progress";
import { IMAGE_LIMIT_HINT, imageLimitError } from '../../../../shared/attachments';
import { ATTACHMENT_ACCEPT, ATTACHMENT_LIMIT_DETAILS, ATTACHMENT_LIMIT_HINT, attachmentSendError, composeAttachmentText } from '@/lib/ingest/limits';

// 统一控件鼠标反馈：悬停边框+阴影+图标放大、聚焦环、按压缩放
const CONTROL_FEEDBACK =
  "group cursor-pointer rounded-md border border-transparent bg-muted transition-all duration-150 hover:border-ring/40 hover:bg-accent hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]";

export function AgentChatPage() {
  const queryClient = useQueryClient();
  const refreshedTasks = useRef(new Set<string>());
  const repository = useRepository();
  const { session } = useAuth();
  const local = localWorkspaceIdentity();
  const owner = local?.owner ?? session?.user.id ?? "demo";
  const alive = useRef(true);
  const requestController = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; requestController.current?.abort(); }; }, []);
  const { active, update, rename, storageError, setActiveId, changeMode, initialLoading, loadingOlder, loadOlder } = useSessions();
  const previousEnd=useRef<{id:string;count:number;key:string}|undefined>(undefined);
  const messageScroll=useRef<HTMLDivElement>(null);
  const olderAnchor=useRef<{id:string;element:Element;top:number}|undefined>(undefined);
  function requestOlder() {
    const container=messageScroll.current, top=container?.getBoundingClientRect().top??0;
    const element=container && [...container.querySelectorAll('[data-message-key]')].find(el=>el.getBoundingClientRect().bottom>top);
    if(element)olderAnchor.current={id:active.id,element,top:element.getBoundingClientRect().top};
    loadOlder();
  }
  useLayoutEffect(()=>{
    const anchor=olderAnchor.current;
    if(!anchor || loadingOlder)return;
    if(anchor.id===active.id && anchor.element.isConnected && messageScroll.current) messageScroll.current.scrollTop+=anchor.element.getBoundingClientRect().top-anchor.top;
    olderAnchor.current=undefined;
  },[active.id,active.messages.length,loadingOlder]);
  const composer = useComposerDraft(active.id);
  const { text: input, attachments, titleEdit } = composer.draft;
  const setInput = composer.setText;
  const [busy, setBusy] = useState(false);
  const [activity,setActivity] = useState<AgentActivity | null>(null);
  const editing = titleEdit !== undefined;
  const incompleteAttachments = attachments.some(a => a.status !== 'ready');
  const [showSetup, setShowSetup] = useState(false);
  const [picking, setPicking] = useState(false);
  const [showOnboard, setShowOnboard] = useState(() => !localStorage.getItem("campusmate.onboarded"));
  const [wsPath, setWsPath] = useState(() => localStorage.getItem(`campusmate.workspace:${owner}`) || "");
  const workspaceKey = ["local-workspace", owner];
  const workspace = useQuery({ queryKey: workspaceKey, queryFn: () => getLocalWorkspace(), enabled: Boolean(local) });
  const [savingPermission, setSavingPermission] = useState(false);
  async function changePermission(permission: "ask" | "full") {
    if (savingPermission || (permission === "full" && !window.confirm("完全访问允许 Agent 以当前系统账户运行命令，后续新任务无需逐次审批。启用完全访问？"))) return;
    setSavingPermission(true);
    try { queryClient.setQueryData(workspaceKey, await setLocalWorkspacePermission(permission)); }
    catch (error) { toast.error(errorMessage(error)); }
    finally { setSavingPermission(false); }
  }
  const fileRef = useRef<HTMLInputElement>(null);
  const [providerId, setProviderId] = useState(
    () => localStorage.getItem(`campusmate.providerId:${owner}`) || "",
  );
  const [reasoning, setReasoning] = useState<"auto" | "low" | "medium" | "high">(() => {
    const stored = localStorage.getItem(`campusmate.reasoning:${owner}`);
    return stored === "low" || stored === "medium" || stored === "high" ? stored : "auto";
  });
  const { data: providers = [], error: providerError } = useQuery({ queryKey: ["providers", owner], queryFn: listProviders });
  const { data: profile } = useQuery({ queryKey: ["profile", owner], queryFn: () => repository.getProfile() });
  const endRef = useRef<HTMLDivElement>(null);
  const provider = providers.find((p: ProviderPublic) => p.id === providerId) ?? providers.find((p) => p.isDefault) ?? providers[0];
  const modelName = provider?.model || "未知模型";
  const contextCap = (backendEnabled() ? active.contextCap : provider?.contextLimit) ?? null;
  const currentTask = active.currentTaskId ? active.taskViews?.[active.currentTaskId]?.task : undefined;
  const monitor = useTaskMonitor(active, update, busy);
  const busyUI = busy || Object.values(active.taskViews ?? {}).some((view) => ["queued", "running"].includes(view.task.status));

  useEffect(() => {
    // Some writes may have succeeded even when a later step fails. Refetch real data
    // after terminal business runs; don't show stale cached lists after navigation.
    for (const view of Object.values(active.taskViews ?? {})) {
      if (!["succeeded", "failed", "cancelled"].includes(view.task.status)) continue;
      if (!view.events.some(e => e.type === "tool.result" && ["save_to_inbox", "create_daily_task", "set_growth_goal", "merge_inbox"].includes(String(e.payload.name)))) continue;
      const key = `${view.task.id}:${view.task.status}:${view.task.updatedAt ?? ""}`;
      if (refreshedTasks.current.has(key)) continue;
      refreshedTasks.current.add(key);
      for (const name of ["inbox", "tasks", "profile"]) void queryClient.invalidateQueries({ queryKey: [name] });
    }
  }, [active.taskViews, queryClient]);

  useEffect(() => {
    const last=active.messages.at(-1), key=last?`${last.historyKey??last.taskId??last.turnId??last.content.slice(0,40)}:${last.role}`:'';
    const previous=previousEnd.current;
    // Prepending a history page must not drag the reader back to the bottom.
    if (!(previous?.id===active.id && active.messages.length>previous.count && previous.key===key)) endRef.current?.scrollIntoView({ behavior: "smooth" });
    previousEnd.current={id:active.id,count:active.messages.length,key};
  }, [active?.messages.length, busy]);

  function chooseProvider(id: string) {
    setProviderId(id);
    localStorage.setItem(`campusmate.providerId:${owner}`, id);
  }

  async function handleFiles(files: FileList | File[]) {
    if (initialLoading) { toast.message('正在恢复会话，请稍候再添加附件。'); return; }
    if (composer.resolving) { toast.message('正在安全保存草稿，请稍候。'); return; }
    try { await composer.addFiles(Array.from(files)); }
    catch (error) { toast.error(error instanceof Error ? error.message : '附件未添加，请重试。'); }
  }

  async function send(retry = false, edit?: { content: string; ordinal: number }) {
    if (initialLoading) { toast.message('正在恢复会话，请稍候。'); return; }
    const imageError = imageLimitError(edit ? 0 : retry ? active.pendingTurn?.images?.length ?? 0 : attachments.filter(a => a.kind === 'image').length);
    if (imageError) { toast.error(imageError); return; }
    const pending = active.pendingTurn;
    const sendError = attachmentSendError(edit?.content ?? (retry ? pending?.content ?? '' : input), edit ? [] : retry ? (pending?.images ?? []).map((dataUrl, index) => ({ name: `重试图片${index + 1}`, kind: 'image' as const, dataUrl })) : attachments);
    if (sendError) { toast.error(sendError); return; }
    if (!edit && !retry && (!composer.ready || incompleteAttachments)) { toast.message('请等待附件解析完成，或移除解析失败的附件后再发送。'); return; }
    if ((!input.trim() && attachments.length === 0 && !edit && !retry) || busyUI || (!backendEnabled() && !profile)) return;
    let currentDraft = composer.draft;
    if (!edit && !retry) {
      const taken = await composer.takeForSend();
      if (!taken) { toast.message('草稿尚未安全提交，请先处理版本冲突或存储提示。'); return; }
      currentDraft = taken;
    }
    const text = (edit ? edit.content : currentDraft.text).trim();
    // Editing a historical message must not consume or attach the separate composer draft.
    const files = edit || retry ? [] : currentDraft.attachments;
    if ((!text && files.length === 0 && !retry) || busyUI || !active || (!backendEnabled() && !profile)) return;
    const content = retry ? active.pendingTurn?.content ?? "" : composeAttachmentText(text, files);
    if (!content) return;
    const pendingTurn = retry && active.pendingTurn ? active.pendingTurn : { turnId: crypto.randomUUID(), content, providerId: provider?.id, reasoning, images: files.filter((a) => a.kind === "image" && a.dataUrl).map((a) => a.dataUrl as string) };
    // A normal send already consumed this exact persisted version atomically.
    // Retrying/editing a historical turn never consumes a newly typed draft.
    setBusy(true);
    setActivity({sessionId:active.id,startedAt:Date.now(),stageAt:Date.now(),progress:{phase:"preparing"}});
    const history: ChatMessage[] = active.messages.map((m) => ({ role: m.role, content: m.content }));
    if (active.name === '新会话') rename(active.id, autoName(content));
    update(active.id, (s) => ({
      ...s,
      pendingTurn: backendEnabled() ? pendingTurn : undefined,
      messages: retry ? s.messages : [...s.messages, { role: "user", content, turnId: pendingTurn.turnId, ...(edit ? { editedFrom: edit.ordinal } : {}) }],
    }));
    let acceptedId: string | undefined;
    let localId: string | undefined;
    try {
      // AC01：配置 VITE_BACKEND_URL 时默认走服务端 Task Runtime（浏览器关闭不影响后台任务）；
      // 未配置时保留浏览器 runChat 作为开发/兼容 fallback。
      if (backendEnabled()) {
        const controller = new AbortController();
        requestController.current = controller;
        const id = await ensureSession({ id: active.backendId ?? backendSessionId(owner, active.id), title: active.name, mode: active.mode }, owner);
        if (!alive.current) return;
        update(active.id, (s) => ({ ...s, backendId: id }));
        const task = await runTaskViaBackend(
          { title: content.slice(0, 80), intent: content, sessionId: id, turnId: pendingTurn.turnId, images: pendingTurn.images, providerId: pendingTurn.providerId, reasoning: pendingTurn.reasoning },
          (t) => {
            if (!alive.current) return;
            update(active.id, (s) => mergeTask(s, t));
          },
          { signal: controller.signal,
            onAccepted: (taskId) => {
              acceptedId = taskId;
              if (alive.current) update(active.id, (s) => mergeTask({ ...s, currentTaskId: taskId, pendingTurn: { ...pendingTurn, taskId } }, { id: taskId, userId: owner, title: content.slice(0, 80), sessionId: id, turnId: pendingTurn.turnId, status: "queued", usage: { tokens: 0, toolCalls: 0, wallMs: 0, costUsd: 0 }, createdAt: Date.now() }));
            },
            onEvent: (event) => { if (alive.current) update(active.id, (s) => mergeEvent(s, event)); },
            onConnection: (connection) => { if (alive.current && acceptedId) update(active.id, (s) => { const view = s.taskViews?.[acceptedId!]; return view ? { ...s, taskViews: { ...s.taskViews, [acceptedId!]: { ...view, connection } } } : s; }); },
          },
        );
        if (!alive.current) return;
        update(active.id, (s) => mergeTask(s, task));
        if (["needs_input", "paused"].includes(task.status)) toast.message("任务需要处理，请查看执行面板。");
      } else {
        localId = `local:${crypto.randomUUID()}`;
        const controller = new AbortController(); requestController.current = controller;
        let eventSeq = 0;
        const localTask = { id: localId, userId: owner, title: content.slice(0, 80), turnId: pendingTurn.turnId, status: "running" as const, usage: { tokens: 0, toolCalls: 0, wallMs: 0, costUsd: 0 }, createdAt: Date.now() };
        update(active.id, (s) => mergeTask({ ...s, currentTaskId: localId }, localTask));
        const out = await runChat({ message: content, history, repository, profile: profile!, providerId: provider?.id, mode: active.mode, model: modelName, memoryScope: `${owner}:${active.id}`, reasoning, signal: controller.signal, onProgress: progress => { if(alive.current) setActivity(current=>current?.sessionId===active.id ? {...current,progress,stageAt:Date.now()}:current); }, onActivity: (type, payload) => { if (alive.current) update(active.id, (s) => mergeEvent(s, { id: ++eventSeq, taskId: localTask.id, seq: eventSeq, type, payload, createdAt: Date.now() })); } });
        if (!alive.current) return;
        if (out.needsSetup) setShowSetup(true);
        update(active.id, (s) => {
          const merged = mergeTask(s, { ...localTask, status: out.needsSetup ? "needs_input" : out.mock || out.failed ? "failed" : "succeeded", usage: { ...localTask.usage, tokens: out.usage.input + out.usage.output, wallMs: Date.now() - localTask.createdAt }, result: { summary: out.reply, artifactIds: [], partial: out.mock || out.failed || out.needsSetup, completion: { state: out.mock || out.failed || out.needsSetup ? "partial" : "complete", reason: out.needsSetup ? "missing_information" : "local_development_reply" } }, modelRuntime: { actualModel: out.model }, promptUsage: { inputTokens: out.contextUsed ?? null, contextLimit: provider?.contextLimit ?? null, outputReserve: 8000, source: "estimated" } });
          return { ...merged, compressed: out.compressed ?? false, pruned: out.pruned ?? false, messages: merged.messages.map((m) => m.taskId === localTask.id ? { ...m, mock: out.mock, failed: out.failed, actions: out.actions } : m) };
        });
      }
    } catch (e) {
      if (!alive.current || (e instanceof DOMException && e.name === "AbortError")) return;
      if (acceptedId) { toast.message("进度连接暂不可用，任务保留在后台，正在重新连接。"); return; }
      // 兜底：runChat 理论上自兜底，此处再防一层，保证 busy 复位且错误可读（绝不 [object Object]）。
      const reason = errorMessage(e);
      if (localId) { update(active.id, (s) => mergeTask(s, { id: localId!, userId: owner, title: content.slice(0, 80), turnId: pendingTurn.turnId, status: "failed", usage: { tokens: 0, toolCalls: 0, wallMs: 0, costUsd: 0 }, error: reason })); toast.error(reason); return; }
      update(active.id, (s) => ({
        ...s,
        messages: [...s.messages, { role: "assistant", content: `处理失败（${reason}）。${backendEnabled() ? "可重试提交同一轮次。" : "请重发本条重试。"}`, failed: true }],
      }));
      toast.error(`处理失败：${reason}`);
    } finally {
      if (alive.current) { setBusy(false); setActivity(null); }
    }
  }

  async function pickWorkspace() {
    setPicking(true);
    try {
      const w = window as unknown as { showDirectoryPicker?: (o?: { mode?: string }) => Promise<{ name: string }> };
      if (typeof w.showDirectoryPicker === "function") {
        // 浏览器原生文件夹对话框：在用户桌面即时弹出，不受服务端会话隔离影响
        const handle = await w.showDirectoryPicker({ mode: "read" });
        setWsPath(handle.name);
        localStorage.setItem(`campusmate.workspace:${owner}`, handle.name);
        toast.success(`工作区已设置：${handle.name}`);
      } else {
        const res = await fetch("/api/workspace/pick");
        const data = await res.json();
        if (data.path) {
          setWsPath(data.path);
          localStorage.setItem(`campusmate.workspace:${owner}`, data.path);
          toast.success("工作区已设置");
        } else {
          toast.error("未选择文件夹");
        }
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") toast.error("无法打开文件夹选择对话框");
    } finally {
      setPicking(false);
    }
  }

  async function saveName() {
    const value = await composer.finishTitle(); // CAS before metadata; Enter+blur commits once
    if (value !== undefined) rename(active.id, value.trim() || active.name);
  }

  return (
    <div
      className="flex h-[calc(100dvh-7rem)] flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
    >
      {/* 会话标题 + 模式 */}
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        {editing ? (
          <input
            autoFocus
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
            aria-label="会话名称"
            disabled={composer.resolving}
            value={titleEdit ?? ''}
            onChange={(e) => composer.setTitleEdit(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); saveName(); } if (e.key === 'Escape') { e.preventDefault(); composer.setTitleEdit(undefined); } }}
          />
        ) : (
          <button
            className="flex min-w-0 items-center gap-2 text-sm font-semibold"
            disabled={initialLoading || !composer.ready || composer.resolving || Boolean(composer.conflict)}
            onClick={() => composer.setTitleEdit(active?.name ?? '')}
            title="点击重命名"
          >
            <span className="truncate">{active?.name}</span>
            <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        )}
        <div className="ml-auto flex items-center gap-1 rounded-md bg-muted p-0.5 text-xs">
          {(["auto", "daily"] as const).map((m) => (
            <button
              key={m}
              className={cn("rounded px-2 py-1", active?.mode === m ? "bg-background shadow-sm" : "text-muted-foreground")}
              disabled={initialLoading}
              onClick={() => changeMode(active.id, m)}
            >
              {m === "auto" ? "自动" : "日常"}
            </button>
          ))}
        </div>
      </header>

      {showOnboard && (
        <div className="border-b border-border bg-secondary/40 px-4 py-2 text-xs text-secondary-foreground">
          <div className="mx-auto flex max-w-3xl items-center gap-2">
            <span className="flex-1">
              描述你的任务，或添加通知与附件开始。执行过程、来源和文档会显示在任务面板；本机资料与群消息需要先连接并授权 Companion。
            </span>
            <button
              className={cn(CONTROL_FEEDBACK, "shrink-0 px-2 py-1")}
              onClick={() => { localStorage.setItem("campusmate.onboarded", "1"); setShowOnboard(false); }}
            >
              知道了
            </button>
          </div>
        </div>
      )}

      {/* 无边框消息流 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
      <div ref={messageScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          {active.historyPage?.hasMore && <button type="button" className="self-center rounded-md border px-3 py-1 text-xs text-muted-foreground disabled:opacity-50" disabled={loadingOlder} onClick={requestOlder}>{loadingOlder?'正在加载更早消息…':'加载更早消息'}</button>}
          {busy && activity && activity.sessionId !== active.id && <button onClick={()=>setActiveId(activity.sessionId)} className="text-sm text-primary underline">查看处理进度</button>}
          {!backendEnabled() && busy && activity?.sessionId === active.id && <AgentActivityCard activity={activity} />}
          {active?.messages.length === 0 && (
            <div className="mt-16 text-center text-sm text-muted-foreground">
              <Bot className="mx-auto mb-3 size-8 text-primary" />
              开始一个会话：粘贴群通知、询问机会、或让我创建日常任务。
            </div>
          )}
          {active?.messages.map((message, i) => <ChatMessageRow key={`${active.id}:${message.role}:${message.historyKey ?? message.turnId ?? message.taskId ?? i}`} message={message} ordinal={i + 1} busy={busyUI} onResend={content => void send(false, { content, ordinal: i + 1 })} />)}
          {!busyUI && active.pendingTurn && !active.pendingTurn.taskId && <Button variant="outline" size="sm" onClick={() => send(true)}>重试提交同一轮次</Button>}
          <div ref={endRef} />
        </div>
      </div>
      <TaskWorkspace key={active.id} session={active} sending={busy} loadError={monitor.error} onSelect={(id) => update(active.id, (s) => ({ ...s, currentTaskId: id }))} onTask={(task) => update(active.id, (s) => mergeTask(s, task))} onRefresh={monitor.refresh} onContinue={(title) => setInput(`请基于已有记录继续：${title}`)} />
      </div>

      {/* 输入区：工作区在输入栏左；模型选择在输入框下、Enter 左；上下文状态 */}
      <div className="border-t border-border bg-background px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {storageError && <p role="alert" className="mb-2 text-xs text-destructive">{storageError}</p>}
          {composer.error && <p role="alert" className="mb-2 text-xs text-destructive">{composer.error}</p>}
          {composer.conflict && <section role="alert" aria-label="草稿版本冲突" className="mb-3 space-y-2 rounded-md border border-amber-500/50 bg-amber-50/30 p-3 text-xs dark:bg-amber-950/10">
            <p className="font-medium">另一标签页修改了同一会话草稿。不会自动覆盖；本页副本和本机最新稿均保留，请选择后再发送。</p>
            <div className="grid gap-2 sm:grid-cols-2"><div><p>本页草稿</p><pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words">{input.slice(0, 600) || '（无文字）'}</pre><p>{attachments.map(a => a.name).join('、') || '无附件'}</p></div><div><p>本机最新草稿</p><pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words">{composer.conflict.draft.text.slice(0, 600) || '（无文字）'}</pre><p>{composer.conflict.draft.attachments.map(a => a.name).join('、') || '无附件'}</p></div></div>
            <div className="flex gap-3"><button type="button" className="underline" disabled={composer.saving || composer.resolving || composer.conflict.deleted} onClick={() => void composer.resolve('local')}>保留本页草稿</button><button type="button" className="underline" disabled={composer.saving || composer.resolving || composer.conflict.deleted} onClick={() => void composer.resolve('remote')}>使用本机最新草稿</button></div>
          </section>}
          {composer.versions.length > 0 && <details className="mb-2 text-xs"><summary className="cursor-pointer">保留的草稿版本（{composer.versions.length}）</summary><div className="max-h-56 space-y-2 overflow-auto py-2">{composer.versions.map((version, i) => <div key={version.key} data-draft-version={version.key} className="rounded border p-2"><p>{version.source === 'conflict' ? '冲突副本' : '操作前备份'} · {new Date(version.createdAt).toLocaleString()}</p><pre className="max-h-20 overflow-auto whitespace-pre-wrap break-words">{version.draft.text.slice(0, 600) || '（无文字）'}</pre><p>{version.draft.attachments.map(a => a.name).join('、') || '无附件'}</p><button type="button" aria-label={`恢复草稿版本 ${i + 1}`} className="underline" disabled={composer.saving || composer.resolving || composer.conflict?.deleted} onClick={() => void composer.resolve({ version: version.key })}>恢复此版本（当前稿也保留）</button></div>)}</div></details>}
          {!composer.ready && <p role="status" className="mb-2 text-xs text-muted-foreground">正在恢复本地草稿…</p>}
          {composer.ready && !composer.error && <p role="status" className="mb-2 text-[10px] text-muted-foreground">{composer.saving ? '草稿正在保存到本机…' : '草稿按会话保存在本机，不跨设备同步'}</p>}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((a) => (
                <span key={a.id} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs">
                  {a.kind === "image" && a.dataUrl ? (
                    <img src={a.dataUrl} alt={a.name} className="size-6 rounded object-cover" />
                  ) : (
                    <Paperclip className="size-3" />
                  )}
                  <span className="max-w-32 truncate">{a.name}</span>
                  {a.status === 'parsing' && <span role="status">正在解析…</span>}
                  {a.status === 'error' && <span role="alert" className="text-destructive">{a.error}</span>}
                  <button aria-label={`移除附件 ${a.name}`} onClick={() => composer.removeAttachment(a.id)}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <Textarea
            disabled={initialLoading || !composer.ready || composer.resolving}
            rows={2}
            className="resize-none border-0 bg-muted focus-visible:ring-1"
            placeholder="输入消息 / 粘贴群通知 / 拖拽或粘贴图片文档…（Enter 发送）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); handleFiles(e.clipboardData.files); } }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {local && (
              <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs">
                <FolderOpen className="size-3.5 shrink-0 text-primary" />
                <span>{workspace.data ? `本地工作区 · ${workspace.data.name}` : workspace.isError ? "本地工作区连接失败" : "正在读取本地工作区"}</span>
                {workspace.data && <select aria-label="工作区权限" className="rounded bg-background px-1 py-0.5" disabled={savingPermission} value={workspace.data.permission} onChange={(e) => void changePermission(e.target.value as "ask" | "full")}>
                  <option value="ask">请求批准</option>
                  <option value="full">完全访问</option>
                </select>}
              </div>
            )}
            {!local && active?.mode === "auto" && (
              <button
                className={cn(CONTROL_FEEDBACK, "flex max-w-56 items-center gap-1 px-2 py-1 text-xs")}
                title="点击选择工作区文件夹"
                onClick={pickWorkspace}
                disabled={picking || backendEnabled()}
              >
                {picking ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                ) : (
                  <FolderOpen className="size-3.5 shrink-0 text-primary transition-transform group-hover:scale-110" />
                )}
                <span className="truncate">{backendEnabled() ? "云端文档工作区" : wsPath || "选择本地文件夹"}</span>
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="hidden"
              onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = ""; }}
            />
            <button
              type="button"
              aria-label="添加附件"
              title={`添加图片/文档附件（${IMAGE_LIMIT_HINT}）`}
              onClick={() => fileRef.current?.click()}
              className={cn(CONTROL_FEEDBACK, "flex size-8 items-center justify-center")}
            >
              <Paperclip className="size-4 text-primary transition-transform group-hover:scale-110" />
            </button>
            <details className="text-[10px] text-muted-foreground"><summary className="cursor-pointer">{IMAGE_LIMIT_HINT} · {ATTACHMENT_LIMIT_HINT}</summary><p className="max-w-md py-1 text-xs">{ATTACHMENT_LIMIT_DETAILS}</p></details>
            <Select value={provider?.id ?? ""} onValueChange={chooseProvider}>
              <SelectTrigger aria-label="模型连接" className={cn("h-8 w-40 text-xs", CONTROL_FEEDBACK)}><SelectValue placeholder="模型" /></SelectTrigger>
              <SelectContent>
                {providers.map((p: ProviderPublic) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                {providers.length === 0 && <SelectItem value="unconfigured" disabled>请配置模型</SelectItem>}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">思考
              <select aria-label="思考强度" className="h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={reasoning} onChange={(e) => { const value = e.target.value as typeof reasoning; setReasoning(value); localStorage.setItem(`campusmate.reasoning:${owner}`, value); }}>
                <option value="auto">自动</option><option value="minimal">最低</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option><option value="max">最大</option>
              </select>
            </label>
            {provider?.capabilities?.reasoning === 'deepseek_thinking' ? <span className="text-xs text-muted-foreground" title="当前模型已接入思考与工具调用；低/中/高分别对应官方low/high/max，内部思考不作为聊天正文展示。">DeepSeek 思考已接入</span> : !["reasoning_effort", "enable_thinking", "chat_template_kwargs"].includes(String(provider?.capabilities?.reasoning)) && <span className="text-xs text-muted-foreground">尚未确认该接口的思考控制能力</span>}
            {providerError && <span className="text-xs text-destructive">模型目录加载失败：{errorMessage(providerError)}</span>}
            {active.actualModel && <span className="text-xs text-muted-foreground" title={`最近任务配置：${active.configuredModel ?? "未知"}`}>最近返回：{active.actualModel}</span>}
            <ContextUsage
              used={active?.contextUsed}
              cap={contextCap}
              tokens={active?.tokens}
              lastRequest={currentTask?.modelRuntime?.lastRequest}
              compressed={active?.compressed}
              pruned={active?.pruned}
              model={active.actualModel ?? modelName}
            />
            <Button size="sm" className="ml-auto" disabled={initialLoading || !composer.ready || composer.resolving || Boolean(composer.conflict) || incompleteAttachments || busyUI || (!input.trim() && attachments.length === 0)} onClick={() => send()}>
              {busyUI ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {busyUI ? "处理中" : "发送"}
            </Button>
          </div>
        </div>
      </div>
      <SetupWizard open={showSetup} onClose={() => setShowSetup(false)} />
    </div>
  );
}


