import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  UserRound, Palette, Cpu, SlidersHorizontal, Database, Sun, Moon, Monitor,
  Download, RotateCcw, ShieldCheck, Check, Bot, CalendarClock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { repository, isDemo, llmProvider } from "@/app/config";
import { resetDemo } from "@/lib/data/demo";
import { useAppearance, type ThemeMode, type StepDensity } from "@/lib/theme";
import { useSessions } from "@/lib/agent/sessions-context";
import { useAuth } from "@/app/auth";
import { cn } from "@/lib/utils";
import type { Profile } from "@/lib/data/types";
import { ProviderSettings } from "./ProviderSettings";

const TABS = [
  { id: "account", label: "账号与画像", icon: UserRound },
  { id: "appearance", label: "通用与外观", icon: Palette },
  { id: "models", label: "模型供应商", icon: Cpu },
  { id: "presets", label: "Agent 预设", icon: SlidersHorizontal },
  { id: "data", label: "数据与隐私", icon: Database },
] as const;
type TabId = (typeof TABS)[number]["id"];

const THEME_CARDS: { id: ThemeMode; label: string; icon: typeof Sun }[] = [
  { id: "light", label: "浅色", icon: Sun },
  { id: "dark", label: "深色", icon: Moon },
  { id: "system", label: "跟随系统", icon: Monitor },
];

export function SettingsPage() {
  const [tab, setTab] = useState<TabId>("account");
  const { appearance, setAppearance } = useAppearance();
  const { session } = useAuth();
  const { active, update } = useSessions();
  const qc = useQueryClient();
  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: () => repository.getProfile() });
  const { data: runs = [] } = useQuery({ queryKey: ["runs"], queryFn: () => repository.listAgentRuns() });
  const [form, setForm] = useState<Profile | null>(null);
  const [defaultMode, setDefaultMode] = useState<string>(() => localStorage.getItem("campusmate.defaultMode") || "auto");

  useEffect(() => { if (profile && !form) setForm(profile); }, [profile, form]);

  const set = (k: keyof Profile, v: unknown) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const list = (k: "interests" | "skills" | "goals") => (form?.[k] ?? []).join("、");
  const setList = (k: "interests" | "skills" | "goals", v: string) =>
    set(k, v.split(/[,，、]/).map((s) => s.trim()).filter(Boolean));

  async function saveProfile() {
    if (!form) return;
    await repository.updateProfile(form);
    await qc.invalidateQueries({ queryKey: ["profile"] });
    toast.success("画像已保存");
  }
  function applyPreset(mode: "auto" | "daily") {
    localStorage.setItem("campusmate.defaultMode", mode);
    setDefaultMode(mode);
    if (active) update(active.id, (s) => ({ ...s, mode }));
    toast.success(mode === "auto" ? "已切换自动模式（全工具+群摄取）" : "已切换日常模式（聚焦日常事务）");
  }
  async function exportData() {
    const payload = {
      profile: await repository.getProfile(),
      inbox: await repository.listInbox(),
      tasks: await repository.listTasks(),
      opportunities: await repository.listOpportunities(),
      reports: await repository.listReports(),
      agentRuns: await repository.listAgentRuns(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "campusmate-data.json"; a.click();
    URL.revokeObjectURL(url);
    toast.success("已导出当前数据");
  }
  function reset() {
    resetDemo();
    toast.success("演示数据已重置，刷新后生效");
    setTimeout(() => window.location.reload(), 600);
  }

  const field = (label: string, key: keyof Profile, placeholder = "") => (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input value={(form?.[key] as string) ?? ""} placeholder={placeholder} onChange={(e) => set(key, e.target.value)} />
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">个人画像、外观、模型供应商与 Agent 工作方式。</p>
      </div>
      <div className="flex flex-col gap-6 md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-48 md:flex-col">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-all",
                tab === t.id ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <t.icon className="size-4" /> {t.label}
            </button>
          ))}
        </nav>

        <div className="cm-card min-w-0 flex-1 p-6">
          {tab === "account" && (
            <div className="flex flex-col gap-5">
              <div className="flex items-center gap-4">
                <span className="cm-glow flex size-14 items-center justify-center rounded-full bg-primary/15 text-xl font-semibold text-primary">
                  {(session?.user?.email?.[0] || form?.name?.[0] || "U").toUpperCase()}
                </span>
                <div>
                  <p className="text-base font-semibold">{session?.user?.email || form?.name || "演示用户"}</p>
                  <p className="text-xs text-muted-foreground">{session ? "真实用户模式 · RLS 隔离" : "Demo · 本地演示数据"}</p>
                </div>
              </div>
              <Separator />
              <div className="grid gap-4 sm:grid-cols-2">
                {field("姓名", "name", "你的名字")}
                {field("专业", "major", "如 计算机科学与技术")}
                {field("年级", "grade", "如 大二")}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">每周时间预算（小时）</Label>
                  <Input type="number" value={form?.timeBudgetHours ?? 0} onChange={(e) => set("timeBudgetHours", Number(e.target.value))} />
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">兴趣（顿号分隔）</Label>
                  <Input value={list("interests")} onChange={(e) => setList("interests", e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">技能（顿号分隔）</Label>
                  <Input value={list("skills")} onChange={(e) => setList("skills", e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">目标（顿号分隔）</Label>
                  <Input value={list("goals")} onChange={(e) => setList("goals", e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">简介</Label>
                  <Input value={form?.bio ?? ""} onChange={(e) => set("bio", e.target.value)} />
                </div>
              </div>
              <div><Button onClick={saveProfile} disabled={!form}><Check className="size-4" />保存画像</Button></div>
            </div>
          )}

          {tab === "appearance" && (
            <div className="flex flex-col gap-6">
              <div>
                <p className="mb-2 text-sm font-medium">外观</p>
                <div className="grid grid-cols-3 gap-3">
                  {THEME_CARDS.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setAppearance({ theme: t.id })}
                      className={cn(
                        "flex flex-col items-center gap-2 rounded-xl border px-4 py-4 text-sm transition-all",
                        appearance.theme === t.id ? "cm-glow border-primary/50 bg-secondary text-secondary-foreground" : "border-border hover:bg-muted",
                      )}
                    >
                      <t.icon className="size-5" /> {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">字号</Label>
                  <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={appearance.fontSize} onChange={(e) => setAppearance({ fontSize: Number(e.target.value) })}>
                    {[12, 13, 14, 15, 16].map((n) => <option key={n} value={n}>{n}px</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">工作步骤展示</Label>
                  <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={appearance.stepDensity} onChange={(e) => setAppearance({ stepDensity: e.target.value as StepDensity })}>
                    <option value="compact">精简</option>
                    <option value="standard">标准</option>
                    <option value="detailed">详细</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">语言</Label>
                  <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={appearance.language} onChange={(e) => setAppearance({ language: e.target.value as "zh" | "en" })}>
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                  </select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">外观实时生效并本地持久化；「跟随系统」随操作系统明暗切换。</p>
            </div>
          )}

          {tab === "models" && <ProviderSettings />}

          {tab === "presets" && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">选择 Agent 的工具与工作方式；设为默认后新会话沿用，并立即应用到当前会话。</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {([
                  { mode: "auto", icon: Bot, title: "自动模式", desc: "全工具 + 群摄取 + 完全访问；适合信息收集、机会发现与跨源核验。" },
                  { mode: "daily", icon: CalendarClock, title: "日常模式", desc: "聚焦调课/班会/讲座等日常事务；工具精简，谨慎创建机会。" },
                ] as const).map((p) => (
                  <button
                    key={p.mode}
                    onClick={() => applyPreset(p.mode)}
                    className={cn(
                      "flex flex-col gap-2 rounded-xl border p-4 text-left transition-all",
                      defaultMode === p.mode ? "cm-glow border-primary/50 bg-secondary" : "border-border hover:bg-muted",
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold"><p.icon className="size-4 text-primary" />{p.title}
                      {defaultMode === p.mode && <Check className="ml-auto size-4 text-primary" />}
                    </span>
                    <span className="text-xs text-muted-foreground">{p.desc}</span>
                  </button>
                ))}
              </div>
              <Separator />
              <div className="text-xs text-muted-foreground">
                <p>数据层：{isDemo ? "Demo（本地演示）" : "Supabase（真实用户）"} · AI Provider：{llmProvider.name}（{llmProvider.mock ? "Mock" : "真实模型"}）</p>
                <p className="mt-1">Agent 执行记录 {runs.length} 条{runs[0] ? ` · 最近 ${runs[0].taskType}/${runs[0].status}` : ""}</p>
              </div>
            </div>
          )}

          {tab === "data" && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={exportData}><Download className="size-4" />导出我的数据</Button>
                {isDemo && <Button variant="outline" onClick={reset}><RotateCcw className="size-4" />重置演示数据</Button>}
              </div>
              <Separator />
              <div className="flex gap-3 text-sm text-muted-foreground">
                <ShieldCheck className="size-5 shrink-0 text-success" />
                <p>聊天记录与简历属敏感个人材料。真实模式下数据按用户隔离（RLS），上传文件存私有 Storage，删除账户级联清除数据与文件。演示模式不采集任何真实个人数据。模型密钥仅存服务端，不落前端。</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}