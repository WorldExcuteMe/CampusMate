import { Link } from "react-router-dom";
import { GraduationCap, Inbox, Radar, ShieldCheck, Sprout, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const MODULES = [
  { icon: Inbox, title: "Campus Inbox", desc: "导入通知，AI 提取结构化信息，经你确认后保存。" },
  { icon: Radar, title: "Opportunity Radar", desc: "竞赛、实习、科研等机会，个性化匹配并给出理由。" },
  { icon: ShieldCheck, title: "Trust Engine", desc: "多源核验机会可信度，每条结论都有证据。" },
  { icon: Sprout, title: "Growth Center", desc: "目标与任务规划，把机会转化为行动与成长。" },
];

export function LandingPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="mx-auto flex max-w-4xl items-center gap-2 px-6 py-4">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <GraduationCap className="size-4" />
        </span>
        <span className="text-sm font-semibold">CampusMate</span>
        <span className="ml-1.5 hidden text-[11px] text-muted-foreground sm:inline">本地优先的校园 Agent</span>
        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link to="/app">进入演示</Link>
        </Button>
      </header>

      <main className="mx-auto max-w-4xl px-6 pb-16 pt-8">
        <div className="max-w-2xl">
          <p className="text-[11px] font-medium tracking-wider text-muted-foreground">LOCAL-FIRST CAMPUS AGENT</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">校园机会管家</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            让重要信息不再被淹没，让有价值的机会真正变成行动。面向大学生的信息管理、机会发现、可信核验与成长 Agent。
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link to="/app">进入演示 <ArrowRight className="size-4" /></Link>
            </Button>
            <span className="text-xs text-muted-foreground">无需注册 · 数据保存在本机浏览器</span>
          </div>
        </div>

        <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
          {MODULES.map((m) => (
            <div key={m.title} className="flex items-start gap-3 bg-card p-4">
              <m.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-medium">{m.title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{m.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-8 text-[11px] text-muted-foreground">本地优先 · 模型密钥与工作区留在你的设备 · 云端仅做可选同步</p>
      </main>
    </div>
  );
}
