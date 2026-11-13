import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Send, Bot, User, Plus, Pencil, Trash2, Loader2, MessageSquare, RefreshCw } from "lucide-react";
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
import { repository } from "@/app/config";
import { runChat } from "@/lib/agent/chat";
import { listProviders, type ProviderPublic, type ChatMessage } from "@/lib/llm/proxy";
import {
  loadSessions,
  saveSessions,
  newSession,
  autoName,
  type ChatSession,
} from "@/lib/agent/sessions";
import { MockBadge } from "@/components/shared";
import { fetchGroupNotices, syncGroupRecords } from "@/lib/ingest/qq";

const CONTEXT_CAP = 16000;

export function AgentChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const s = loadSessions();
    return s.length ? s : [newSession()];
  });
  const [activeId, setActiveId] = useState(() => sessions[0]?.id);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [providerId, setProviderId] = useState(
    () => localStorage.getItem("campusmate.providerId") || "builtin-deepseek",
  );
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: listProviders });
  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: () => repository.getProfile() });
  const endRef = useRef<HTMLDivElement>(null);

  const active = useMemo(() => sessions.find((s) => s.id === activeId) ?? sessions[0], [sessions, activeId]);

  useEffect(() => {
    saveSessions(sessions);
  }, [sessions]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages.length, busy]);

  function update(fn: (s: ChatSession) => ChatSession) {
    setSessions((list) => list.map((s) => (s.id === active.id ? fn(s) : s)));
  }

  function chooseProvider(id: string) {
    setProviderId(id);
    localStorage.setItem("campusmate.providerId", id);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || !profile || !active) return;
    setInput("");
    setBusy(true);
    const history: ChatMessage[] = active.messages.map((m) => ({ role: m.role, content: m.content }));
    update((s) => ({
      ...s,
      name: s.name === "新会话" ? autoName(text) : s.name,
      messages: [...s.messages, { role: "user", content: text }],
    }));
    const out = await runChat({ message: text, history, repository, profile, providerId, mode: active.mode });
    update((s) => ({
      ...s,
      tokens: s.tokens + out.usage.input + out.usage.output,
      messages: [...s.messages, { role: "assistant", content: out.reply, actions: out.actions, mock: out.mock }],
    }));
    setBusy(false);
  }

  function createSession() {
    const s = newSession(active?.mode ?? "auto");
    setSessions((l) => [s, ...l]);
    setActiveId(s.id);
  }

  function removeSession(id: string) {
    setSessions((l) => {
      const next = l.filter((s) => s.id !== id);
      const fin = next.length ? next : [newSession()];
      if (id === activeId) setActiveId(fin[0].id);
      return fin;
    });
  }

  function saveName() {
    update((s) => ({ ...s, name: nameDraft.trim() || s.name }));
    setEditing(false);
  }

  async function syncGroup() {
    setSyncing(true);
    try {
      const records = await fetchGroupNotices("网安2401官方群");
      const sum = await syncGroupRecords(records, repository);
      qc.invalidateQueries();
      toast.success(`群同步：Inbox ${sum.inbox} / 日常 ${sum.daily} / 机会 ${sum.opportunity}（去重跳过 ${sum.skipped}）`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "群同步失败（需本地 QQ 已登录并先 key+decrypt）");
    }
    setSyncing(false);
  }

  return (
    <div className="flex h-[calc(100dvh-7rem)] gap-0">
      {/* 会话列表 */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border md:flex">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold">会话</span>
          <Button size="icon-xs" variant="ghost" aria-label="新会话" onClick={createSession}>
            <Plus className="size-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={cn(
                "group mb-1 flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm",
                s.id === active.id ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
              onClick={() => setActiveId(s.id)}
            >
              <MessageSquare className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <button
                className="hidden shrink-0 text-muted-foreground hover:text-destructive group-hover:block"
                aria-label="删除会话"
                onClick={(e) => { e.stopPropagation(); removeSession(s.id); }}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* 主工作区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          {editing ? (
            <input
              autoFocus
              className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
            />
          ) : (
            <button
              className="flex min-w-0 items-center gap-2 text-sm font-semibold"
              onClick={() => { setNameDraft(active?.name ?? ""); setEditing(true); }}
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
                onClick={() => update((s) => ({ ...s, mode: m }))}
              >
                {m === "auto" ? "自动" : "日常"}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" className="md:hidden" onClick={createSession}>
            <Plus className="size-4" />
          </Button>
        </header>

        {/* 无边框消息流 */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
            {active?.messages.length === 0 && (
              <div className="mt-16 text-center text-sm text-muted-foreground">
                <Bot className="mx-auto mb-3 size-8 text-primary" />
                开始一个会话：粘贴群通知、询问机会、或让我创建日常任务。
              </div>
            )}
            {active?.messages.map((m, i) => (
              <div key={i} className={cn("flex gap-3", m.role === "user" ? "justify-end" : "justify-start")}>
                {m.role === "assistant" && <Bot className="mt-1 size-5 shrink-0 text-primary" />}
                <div className={cn("max-w-[85%] whitespace-pre-wrap text-sm leading-relaxed", m.role === "user" ? "rounded-2xl rounded-br-sm bg-secondary px-4 py-2.5 text-secondary-foreground" : "")}>
                  {m.content}
                  {m.mock && <div className="mt-2"><MockBadge /></div>}
                  {m.actions && m.actions.length > 0 && (
                    <div className="mt-2 text-xs text-muted-foreground">已同步：{m.actions.join("；")}</div>
                  )}
                </div>
                {m.role === "user" && <User className="mt-1 size-5 shrink-0 text-muted-foreground" />}
              </div>
            ))}
            {busy && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
            <div ref={endRef} />
          </div>
        </div>

        {/* 输入区：模型选择在输入框下、Enter 左；上下文状态 */}
        <div className="border-t border-border bg-background px-4 py-3">
          <div className="mx-auto max-w-3xl">
            <Textarea
              rows={2}
              className="resize-none border-0 bg-muted focus-visible:ring-1"
              placeholder="输入消息或粘贴群通知…（Enter 发送，Shift+Enter 换行）"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
            />
            <div className="mt-2 flex items-center gap-3">
              <Select value={providerId} onValueChange={chooseProvider}>
                <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="模型" /></SelectTrigger>
                <SelectContent>
                  {providers.map((p: ProviderPublic) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                  {providers.length === 0 && <SelectItem value="builtin-deepseek">DeepSeek（内置）</SelectItem>}
                </SelectContent>
              </Select>
              {active?.mode === "auto" && (
                <Button size="sm" variant="outline" disabled={syncing} onClick={syncGroup}>
                  {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  同步群通知
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                上下文 {(active?.tokens ?? 0).toLocaleString()} / {CONTEXT_CAP.toLocaleString()} tok
              </span>
              <Button size="sm" className="ml-auto" disabled={busy || !input.trim()} onClick={send}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                发送
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}