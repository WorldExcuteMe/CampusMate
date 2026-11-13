import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Send, Bot, User, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { repository } from "@/app/config";
import { runChat } from "@/lib/agent/chat";
import { listProviders, type ProviderPublic, type ChatMessage } from "@/lib/llm/proxy";
import { MockBadge, PageHeader } from "@/components/shared";
import { cn } from "@/lib/utils";

interface Msg {
  role: "user" | "assistant";
  content: string;
  actions?: string[];
  mock?: boolean;
}

export function AgentChatPage() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [providerId, setProviderId] = useState<string>(
    () => localStorage.getItem("campusmate.providerId") || "builtin-deepseek",
  );
  const { data: providers = [] } = useQuery({ queryKey: ["providers"], queryFn: listProviders });
  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: () => repository.getProfile() });
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  function chooseProvider(id: string) {
    setProviderId(id);
    localStorage.setItem("campusmate.providerId", id);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || !profile) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", content: text }]);
    setBusy(true);
    const history: ChatMessage[] = msgs.map((m) => ({ role: m.role, content: m.content }));
    const out = await runChat({ message: text, history, repository, profile, providerId });
    setMsgs((m) => [...m, { role: "assistant", content: out.reply, actions: out.actions, mock: out.mock }]);
    setBusy(false);
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-8rem)] max-w-3xl flex-col">
      <PageHeader
        title="Agent 对话"
        description="自然语言驱动：提取通知、创建日常任务、检索与匹配机会。"
        actions={
          <Select value={providerId} onValueChange={chooseProvider}>
            <SelectTrigger className="w-48"><SelectValue placeholder="选择模型" /></SelectTrigger>
            <SelectContent>
              {providers.map((p: ProviderPublic) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
              {providers.length === 0 && <SelectItem value="builtin-deepseek">DeepSeek（内置）</SelectItem>}
            </SelectContent>
          </Select>
        }
      />
      <Card className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {msgs.length === 0 && (
          <p className="text-sm text-muted-foreground">
            试试：「把这条群通知整理成待办：周五19:00开班会」或「帮我找适合我的竞赛」。
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={cn("flex gap-2", m.role === "user" ? "justify-end" : "justify-start")}>
            {m.role === "assistant" && <Bot className="mt-1 size-4 shrink-0 text-primary" />}
            <div
              className={cn(
                "max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
              )}
            >
              {m.content}
              {m.mock && <div className="mt-1"><MockBadge /></div>}
              {m.actions && m.actions.length > 0 && (
                <div className="mt-1 text-xs opacity-70">动作：{m.actions.join("；")}</div>
              )}
            </div>
            {m.role === "user" && <User className="mt-1 size-4 shrink-0 text-muted-foreground" />}
          </div>
        ))}
        {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <div ref={endRef} />
      </Card>
      <div className="mt-3 flex gap-2">
        <Textarea
          rows={2}
          placeholder="输入消息或粘贴群通知…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button disabled={busy || !input.trim()} onClick={send} aria-label="发送">
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  );
}