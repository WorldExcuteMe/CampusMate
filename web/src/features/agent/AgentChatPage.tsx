import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Send, Bot, User, Pencil, Loader2, FolderOpen, Paperclip, X,
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
import { errorMessage } from "@/lib/llm/errors";
import { listProviders, type ProviderPublic, type ChatMessage } from "@/lib/llm/proxy";
import { useSessions } from "@/lib/agent/sessions-context";
import { autoName } from "@/lib/agent/sessions";
import { resolveContextCap } from "@/lib/agent/context";
import { MockBadge } from "@/components/shared";
import { SetupWizard } from "./SetupWizard";
import { parseFile, type Attachment } from "@/lib/ingest/files";

// 统一控件鼠标反馈：悬停边框+阴影+图标放大、聚焦环、按压缩放
const CONTROL_FEEDBACK =
  "group cursor-pointer rounded-md border border-transparent bg-muted transition-all duration-150 hover:border-ring/40 hover:bg-accent hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]";

const WORKSPACES = [
  { id: "local", name: "本地工作区", path: "C:\\Users\\Asus\\Documents\\QQ工具", python: "miniconda3 (64-bit)" },
];

export function AgentChatPage() {
  const { active, update, rename } = useSessions();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [ws] = useState("local");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showSetup, setShowSetup] = useState(false);
  const [picking, setPicking] = useState(false);
  const [showOnboard, setShowOnboard] = useState(() => !localStorage.getItem("campusmate.onboarded"));
  const [wsPath, setWsPath] = useState(() => localStorage.getItem("campusmate.workspace") || "");
  const fileRef = useRef<HTMLInputElement>(null);
  const [providerId, setProviderId] = useState(
    () => localStorage.getItem("campusmate.providerId") || "builtin-deepseek",
  );
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: listProviders });
  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: () => repository.getProfile() });
  const endRef = useRef<HTMLDivElement>(null);
  const workspace = WORKSPACES.find((w) => w.id === ws) ?? WORKSPACES[0];
  const provider = providers.find((p: ProviderPublic) => p.id === providerId);
  const modelName = provider?.model || "deepseek-chat";
  const contextCap = resolveContextCap(modelName);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages.length, busy]);

  function chooseProvider(id: string) {
    setProviderId(id);
    localStorage.setItem("campusmate.providerId", id);
  }

  async function handleFiles(files: FileList | File[]) {
    const parsed = await Promise.all(Array.from(files).map(parseFile));
    setAttachments((a) => [...a, ...parsed]);
  }

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || busy || !profile || !active) return;
    const docText = attachments.filter((a) => a.kind === "doc" && a.text).map((a) => `\n[附件 ${a.name}]\n${a.text}`).join("");
    const imgMarkers = attachments.filter((a) => a.kind === "image").map((a) => `[图片附件 ${a.name}]`).join(" ");
    const content = (text + docText + (imgMarkers ? "\n" + imgMarkers : "")).trim();
    setInput("");
    setAttachments([]);
    setBusy(true);
    const history: ChatMessage[] = active.messages.map((m) => ({ role: m.role, content: m.content }));
    update(active.id, (s) => ({
      ...s,
      name: s.name === "新会话" ? autoName(content) : s.name,
      messages: [...s.messages, { role: "user", content }],
    }));
    try {
      const out = await runChat({ message: content, history, repository, profile, providerId, mode: active.mode, model: modelName });
      if (out.needsSetup) setShowSetup(true);
      update(active.id, (s) => ({
        ...s,
        tokens: s.tokens + out.usage.input + out.usage.output,
        contextUsed: out.contextUsed ?? s.contextUsed ?? 0,
        contextCap: out.contextCap ?? contextCap,
        compressed: out.compressed ?? false,
        pruned: out.pruned ?? false,
        messages: [...s.messages, { role: "assistant", content: out.reply, actions: out.actions, mock: out.mock }],
      }));
    } catch (e) {
      // 兜底：runChat 理论上自兜底，此处再防一层，保证 busy 复位且错误可读（绝不 [object Object]）。
      const reason = errorMessage(e);
      update(active.id, (s) => ({
        ...s,
        messages: [...s.messages, { role: "assistant", content: `处理失败（${reason}）。请重发本条重试。`, mock: true }],
      }));
      toast.error(`处理失败：${reason}`);
    } finally {
      setBusy(false);
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
        localStorage.setItem("campusmate.workspace", handle.name);
        toast.success(`工作区已设置：${handle.name}`);
      } else {
        const res = await fetch("/api/workspace/pick");
        const data = await res.json();
        if (data.path) {
          setWsPath(data.path);
          localStorage.setItem("campusmate.workspace", data.path);
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

  function saveName() {
    rename(active.id, nameDraft.trim() || active.name);
    setEditing(false);
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

      {showOnboard && (
        <div className="border-b border-border bg-secondary/40 px-4 py-2 text-xs text-secondary-foreground">
          <div className="mx-auto flex max-w-3xl items-center gap-2">
            <span className="flex-1">
              首次使用：点「选择工作区文件夹」设定本地目录；粘贴/拖拽通知或附件即可解析；输入「去QQ/微信群获取信息」会自动引导配置环境并摄取、更新 Dashboard。
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
              </div>
              {m.role === "user" && <User className="mt-1 size-5 shrink-0 text-muted-foreground" />}
            </div>
          ))}
          {busy && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
          <div ref={endRef} />
        </div>
      </div>

      {/* 输入区：工作区在输入栏左；模型选择在输入框下、Enter 左；上下文状态 */}
      <div className="border-t border-border bg-background px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((a, i) => (
                <span key={i} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs">
                  {a.kind === "image" && a.dataUrl ? (
                    <img src={a.dataUrl} alt={a.name} className="size-6 rounded object-cover" />
                  ) : (
                    <Paperclip className="size-3" />
                  )}
                  <span className="max-w-32 truncate">{a.name}</span>
                  <button aria-label="移除附件" onClick={() => setAttachments((l) => l.filter((_, j) => j !== i))}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <Textarea
            rows={2}
            className="resize-none border-0 bg-muted focus-visible:ring-1"
            placeholder="输入消息 / 粘贴群通知 / 拖拽或粘贴图片文档…（Enter 发送）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); handleFiles(e.clipboardData.files); } }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {active?.mode === "auto" && (
              <button
                className={cn(CONTROL_FEEDBACK, "flex max-w-56 items-center gap-1 px-2 py-1 text-xs")}
                title="点击选择工作区文件夹"
                onClick={pickWorkspace}
                disabled={picking}
              >
                {picking ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                ) : (
                  <FolderOpen className="size-3.5 shrink-0 text-primary transition-transform group-hover:scale-110" />
                )}
                <span className="truncate">{wsPath || workspace.path || "选择工作区文件夹"}</span>
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,.pdf,.docx,.txt,.md"
              className="hidden"
              onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = ""; }}
            />
            <button
              type="button"
              aria-label="添加附件"
              title="添加图片/文档附件"
              onClick={() => fileRef.current?.click()}
              className={cn(CONTROL_FEEDBACK, "flex size-8 items-center justify-center")}
            >
              <Paperclip className="size-4 text-primary transition-transform group-hover:scale-110" />
            </button>
            <Select value={providerId} onValueChange={chooseProvider}>
              <SelectTrigger className={cn("h-8 w-40 text-xs", CONTROL_FEEDBACK)}><SelectValue placeholder="模型" /></SelectTrigger>
              <SelectContent>
                {providers.map((p: ProviderPublic) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                {providers.length === 0 && <SelectItem value="builtin-deepseek">DeepSeek（内置）</SelectItem>}
              </SelectContent>
            </Select>
            <span
              className="text-xs text-muted-foreground"
              title={`上下文组成：system+工具定义+历史摘要+近期历史+当前输入+输出预留；模型 ${modelName} 上限 ${contextCap.toLocaleString()} tok；累计用量 ${(active?.tokens ?? 0).toLocaleString()} tok`}
            >
              上下文 {(active?.contextUsed ?? 0).toLocaleString()} / {contextCap.toLocaleString()} tok
              {active?.compressed && (
                <span className="ml-1 rounded bg-amber-500/15 px-1 py-0.5 text-amber-600">已压缩</span>
              )}
              {active?.pruned && !active?.compressed && (
                <span className="ml-1 rounded bg-info/15 px-1 py-0.5 text-info">工具截断</span>
              )}
            </span>
            <Button size="sm" className="ml-auto" disabled={busy || (!input.trim() && attachments.length === 0)} onClick={send}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              发送
            </Button>
          </div>
        </div>
      </div>
      <SetupWizard open={showSetup} onClose={() => setShowSetup(false)} />
    </div>
  );
}