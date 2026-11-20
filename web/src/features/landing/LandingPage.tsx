import { Link } from "react-router-dom";
import { ArrowRight, Check, FileText, Sparkles, Terminal } from "lucide-react";

const MODULES = [
  { no: "01", title: "信息中心", desc: "通知、公告、群消息统一收件，提取时间、对象与要求。" },
  { no: "02", title: "校园日历", desc: "课表导入、周次/单双周/节次映射，课程与截止日同屏。" },
  { no: "03", title: "任务与目标", desc: "把通知与计划拆成可执行任务，支持截止提醒与成长目标。" },
  { no: "04", title: "机会中心", desc: "竞赛、实习、科研、奖学金，按画像匹配并跟踪截止。" },
  { no: "05", title: "可信核验", desc: "多源交叉核验，结论附来源；未核实明确标注。" },
  { no: "06", title: "成长中心", desc: "从机会到行动，记录阶段成果与下一步。" },
];

const ARTIFACTS = ["DOCX", "PPTX", "XLSX", "CSV", "HTML", "PDF（打印）", "SVG", "Mermaid", "JSON"];

export function LandingPage() {
  return (
    <div className="min-h-dvh bg-[#080a0d] text-[#e7eaf0] antialiased">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#080a0d]/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5">
          <Link to="/" className="flex min-w-0 items-center gap-3" aria-label="CampusMate 首页">
            <span className="rounded-xl bg-white px-2 py-1.5 shadow-sm ring-1 ring-black/10">
              <img src="/campusmate-logo.png" alt="CampusMate" className="h-8 w-auto object-contain" />
            </span>
            <span className="hidden text-sm font-semibold tracking-tight text-white/90 sm:inline">CampusMate</span>
            <span className="hidden rounded-full border border-white/15 px-2 py-0.5 text-[10px] text-white/45 md:inline">Campus Agent Harness</span>
          </Link>
          <nav className="ml-auto hidden items-center gap-6 text-[12px] text-white/55 md:flex" aria-label="页面导航">
            <a href="#workflow" className="transition-colors hover:text-white">工作流</a>
            <a href="#capabilities" className="transition-colors hover:text-white">能力</a>
            <a href="#artifacts" className="transition-colors hover:text-white">产物</a>
          </nav>
          <Link to="/app" className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[12px] font-semibold text-[#0b0d10] transition-transform hover:scale-[1.02] md:ml-4">
            打开工作台 <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl gap-12 px-5 pb-20 pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:pt-24">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] tracking-[0.16em] text-white/45">
              <Sparkles className="size-3 text-[#7aa2ff]" /> CAMPUSMATE HARNESS · 2026
            </p>
            <h1 className="mt-6 max-w-xl text-4xl font-semibold leading-[1.12] tracking-tight text-white sm:text-5xl">
              把校园里的信息，
              <br />
              变成可执行的下一步。
            </h1>
            <p className="mt-5 max-w-lg text-[14px] leading-7 text-white/55">
              一个面向大学生的 Agent 工作台：导入通知与课表，制定计划，检索核验，直接交付 Word、PPT、Excel、HTML 等成品。
              不是聊天机器人，而是能把事情做完的校园助理。
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link to="/app" className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#5b8cff] px-5 text-sm font-semibold text-white shadow-[0_0_0_1px_rgba(91,140,255,.4),0_10px_30px_-10px_rgba(91,140,255,.8)] transition-transform hover:scale-[1.02]">
                进入演示 <ArrowRight className="size-4" />
              </Link>
              <a href="#workflow" className="inline-flex h-11 items-center gap-2 rounded-xl border border-white/15 px-5 text-sm text-white/75 transition-colors hover:border-white/30 hover:text-white">
                看它如何工作
              </a>
            </div>
            <p className="mt-4 text-[11px] text-white/35">无需注册 · 支持 Qoder 登录 · 数据按账号隔离</p>
          </div>

          <div className="relative">
            <div className="pointer-events-none absolute -inset-8 rounded-[32px] bg-[radial-gradient(circle_at_50%_20%,rgba(91,140,255,.16),transparent_60%)]" />
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0c1016] shadow-[0_30px_80px_-30px_rgba(0,0,0,.9)]">
              <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.02] px-4 py-3">
                <span className="size-2.5 rounded-full bg-[#ff5f57]" />
                <span className="size-2.5 rounded-full bg-[#febc2e]" />
                <span className="size-2.5 rounded-full bg-[#28c840]" />
                <span className="ml-3 font-mono text-[11px] text-white/40">campusmate — agent</span>
                <span className="ml-auto rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] text-white/30">zsh</span>
              </div>
              <div className="space-y-2.5 px-5 py-6 font-mono text-[12px] leading-6">
                <p><span className="text-[#6ee7a8]">$</span> <span className="text-white/80">campusmate plan --term 2026-fall</span></p>
                <p className="text-white/40">→ 读取 课表.xlsx · 识别 32 门课程 · 20 周</p>
                <p><span className="text-[#6ee7a8]">✓</span> 已写入校园日历 <span className="text-white/30">(单双周已处理)</span></p>
                <p><span className="text-[#6ee7a8]">✓</span> 生成 6 节备战计划 · 合并导出</p>
                <p><span className="text-[#7aa2ff]">→</span> DOCX / PPTX / HTML / PDF <span className="text-white/30">就绪</span></p>
                <p className="pt-1 text-white/30">等待下一条指令 <span className="animate-pulse text-[#7aa2ff]">▍</span></p>
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-white/10 bg-white/[0.015]">
          <div className="mx-auto grid max-w-6xl grid-cols-3 divide-x divide-white/10 px-5">
            {[["06", "校园模块"], ["09", "成品格式"], ["∞", "多轮长任务"]].map(([value, label]) => (
              <div key={label} className="px-4 py-6 text-center first:pl-0 last:pr-0">
                <p className="text-2xl font-semibold tracking-tight text-white">{value}</p>
                <p className="mt-1 text-[11px] text-white/35">{label}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="workflow" className="mx-auto max-w-6xl px-5 py-20">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-[10px] tracking-[0.18em] text-white/35">WORKFLOW</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">一个入口，走完整条任务链</h2>
            </div>
            <p className="max-w-md text-xs leading-6 text-white/40">从文件到成品，中间的检索、核验、分节与续跑都由 Agent 处理；你只需要确认方向。</p>
          </div>
          <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 md:grid-cols-3">
            {[
              { step: "01", title: "导入", desc: "通知、课表、PDF、Word、Excel、图片直接拖入；文档跨轮保留。" },
              { step: "02", title: "计划", desc: "先给章节与验收标准，可选项确认后再执行；缺信息会主动追问。" },
              { step: "03", title: "交付", desc: "分节生成并合并导出；未完成会说明进度，不谎称完成。" },
            ].map((item) => (
              <div key={item.step} className="bg-[#0a0d12] p-6">
                <span className="font-mono text-[11px] text-[#7aa2ff]">{item.step}</span>
                <h3 className="mt-3 text-base font-semibold text-white">{item.title}</h3>
                <p className="mt-2 text-xs leading-6 text-white/45">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="capabilities" className="mx-auto max-w-6xl px-5 pb-20">
          <p className="text-[10px] tracking-[0.18em] text-white/35">CAPABILITIES</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">覆盖校园生活的六个工作面</h2>
          <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-3">
            {MODULES.map((m) => (
              <div key={m.no} className="group bg-[#0a0d12] p-6 transition-colors hover:bg-[#0d121a]">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] text-white/25">{m.no}</span>
                  <span className="size-1.5 rounded-full bg-[#5b8cff]/0 transition-colors group-hover:bg-[#5b8cff]" />
                </div>
                <h3 className="mt-4 text-sm font-semibold text-white">{m.title}</h3>
                <p className="mt-2 text-xs leading-6 text-white/45">{m.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="artifacts" className="border-y border-white/10 bg-white/[0.015]">
          <div className="mx-auto max-w-6xl px-5 py-16">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-[10px] tracking-[0.18em] text-white/35">ARTIFACTS</p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">交付成品，而不是一段 Markdown</h2>
              </div>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-white/35"><FileText className="size-3.5" /> 多节长文可合并导出</span>
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              {ARTIFACTS.map((item) => (
                <span key={item} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 font-mono text-[11px] text-white/55">{item}</span>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-20">
          <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#0c1016] px-6 py-12 text-center sm:px-12">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(91,140,255,.18),transparent_55%)]" />
            <Terminal className="mx-auto size-6 text-[#7aa2ff]" />
            <h2 className="mt-5 text-2xl font-semibold tracking-tight text-white">把下一件事，交给 CampusMate</h2>
            <p className="mx-auto mt-3 max-w-md text-xs leading-6 text-white/45">无需注册即可体验。登录 Qoder 后，聊天记录、课表与产物按账号隔离保存。</p>
            <Link to="/app" className="mt-7 inline-flex h-11 items-center gap-2 rounded-xl bg-white px-6 text-sm font-semibold text-[#0b0d10] transition-transform hover:scale-[1.02]">
              进入演示 <ArrowRight className="size-4" />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-5 py-8 text-[11px] text-white/30">
          <span className="rounded-lg bg-white px-1.5 py-1"><img src="/campusmate-logo.png" alt="CampusMate" className="h-5 w-auto object-contain" /></span>
          <span>CampusMate · 校园机会管家</span>
          <span className="hidden md:inline">·</span>
          <span className="hidden md:inline">信息本位 · 机会雷达 · Agent Harness</span>
          <span className="ml-auto">© 2026 CampusMate</span>
        </div>
      </footer>
    </div>
  );
}
