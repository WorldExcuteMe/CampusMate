import { Link } from "react-router-dom";
import { GraduationCap, Inbox, Radar, ShieldCheck, Sprout, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const MODULES = [
  { icon: Inbox, title: "Campus Inbox", desc: "导入通知，AI 提取结构化信息，经你确认后保存。" },
  { icon: Radar, title: "Opportunity Radar", desc: "竞赛、实习、科研等机会，个性化匹配并给出理由。" },
  { icon: ShieldCheck, title: "Trust Engine", desc: "多源核验机会可信度，每条结论都有证据。" },
  { icon: Sprout, title: "Growth Center", desc: "目标与任务规划，把机会转化为行动与成长。" },
];

export function LandingPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="mx-auto flex max-w-5xl items-center gap-2 px-6 py-5">
        <GraduationCap className="size-6 text-primary" />
        <span className="text-lg font-semibold">CampusMate</span>
        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link to="/app">进入演示</Link>
        </Button>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-16 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">校园机会管家</h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
          让重要信息不再被淹没，让有价值的机会真正变成行动。
        </p>
        <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground">
          面向大学生的智能信息管理、机会发现、可信度核验与个人成长 Agent。
        </p>
        <Button asChild size="lg" className="mt-8">
          <Link to="/app">无需注册，体验演示 <ArrowRight className="size-4" /></Link>
        </Button>
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-6 pb-20 sm:grid-cols-2">
        {MODULES.map((m) => (
          <Card key={m.title}>
            <CardContent className="flex items-start gap-3 p-5">
              <m.icon className="size-6 shrink-0 text-primary" />
              <div>
                <p className="font-semibold">{m.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{m.desc}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}