import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Send, Bot, User, Pencil, Loader2, RefreshCw, FolderOpen, ChevronDown,
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
import { repository } from "@/app/config";
import { runChat } from "@/lib/agent/chat";
import { listProviders, type ProviderPublic, type ChatMessage } from "@/lib/llm/proxy";
import { useSessions } from "@/lib/agent/sessions-context";
import { autoName } from "@/lib/agent/sessions";
import { fetchGroupNotices, fetchWechatNotices, syncGroupRecords } from "@/lib/ingest/qq";
import { MockBadge } from "@/components/shared";

const CONTEXT_CAP = 16000;

const WORKSPACES = [
  { id: "local", name: "本地工作区", path: "C:\\Users\\Asus\\Documents\\QQ工具", python: "miniconda3 (64-bit)" },
];

export function AgentChatPage() {
  const { active, update, rename } = useSessions();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [ws, setWs] = useState("local");
  const [syncing, setSyncing] = useState(false);
  const [providerId, setProviderId] = useState(
    () => localStorage.getItem("campusmate.providerId") || "builtin-deepseek",
  );
  const qc = useQueryClient();
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: listProviders });
  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: () => repository.getProfile() });
  const endRef = useRef<HTMLDivElement>(null);
  const workspace = WORKSPACES.find((w) => w.id === ws) ?? WORKSPACES[0];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages.length, busy]);

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
    update(active.id, (s) => ({
      ...s,
      name: s.name === "新会话" ? autoName(text) : s.name,
      messages: [...s.messages, { role: "user", content: text }],
    }));
    const out = await runChat({ message: text, history, repository, profile, providerId, mode: active.mode });
    update(active.id, (s) => ({
      ...s,
      tokens: s.tokens + out.usage.input + out.usage.output,
      messages: [...s.messages, { role: "assistant", content: out.reply, actions: out.actions, mock: out.mock }],
    }));
    setBusy(false);
  }

  async function syncGroup() {
    setSyncing(true);
    const records = [];
    const errs: string[] = [];
    try { records.push(...(await fetchGroupNotices("网安2401官方群"))); }
    catch (e) { errs.push(`QQ: ${e instanceof Error ? e.message : "失败"}`); }
    try { records.push(...(await fetchWechatNotices("网安2401班"))); }
    catch (e) { errs.push(`微信: ${e instanceof Error ? e.message : "失败"}`); }
    if (records.length) {
      const sum = await syncGroupRecords(records, repository);
      qc.invalidateQueries();
      toast.success(`群同步：Inbox ${sum.inbox} / 日常 ${sum.daily} / 机会 ${sum.opportunity}（跳过 ${sum.skipped}）`);
    } else {
      toast.error(errs.join("；") || "无可用群通知（需本地 QQ/微信已登录）");
    }
    setSyncing(false);
  }

  function saveName() {
    rename(active.id, nameDraft.trim() || active.name);
    setEditing(false);
  }

  return (
    <div className="flex h-[calc(100dvh-7rem)] flex-col">
      {/* 工作区栏（参考 Qoder / DeepSeek harness） */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <FolderOpen className="size-3.5 text-primary" />
        <Select value={ws} onValueChange={setWs}>
          <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {WORKSPACES.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="truncate font-mono">{workspace.path}</span>
        <span className="rounded bg-muted px-1.5 py-0.5">{workspace.python}</span>
        <span className="ml-auto hidden sm:inline">自动模式可在此工作区执行 py 摄取/工具</span>
      </div>

      {/* 会话标题 + 模式 */}
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
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
              onClick={() => update(active.id, (s) => ({ ...s, mode: m }))}
            >
              {m === "auto" ? "自动" : "日常"}
            </button>
          ))}
        </div>
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
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <div className="mt-2 flex items-center gap-3">
            <Select value={providerId} onValueChange={chooseProvider}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="模型" /></SelectTrigger>
              <SelectContent>
                {providers.map((p: ProviderPublic) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
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
  );
}