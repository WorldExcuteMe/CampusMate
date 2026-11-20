import { Link } from "react-router-dom";
import { ArrowRight, FileText, Inbox, Radar, ShieldCheck, Sprout, Terminal, CalendarDays, ListTodo } from "lucide-react";

const NAV = [
  { href: "#capabilities", label: "能力" },
  { href: "#artifacts", label: "产物" },
];

const SIDEBAR = [
  { icon: Inbox, label: "信息中心" },
  { icon: CalendarDays, label: "校园日历" },
  { icon: ListTodo, label: "任务与目标" },
  { icon: Radar, label: "机会中心" },
  { icon: ShieldCheck, label: "可信核验" },
  { icon: Sprout, label: "成长中心" },
];

const CAPS = [
  { title: "通知与文档", desc: "导入通知、PDF、Word、Excel、图片，提取时间与要求。" },
  { title: "课表与日历", desc: "解析课表，兼容周次、单双周与节次，写入校园日历。" },
  { title: "长任务与成品", desc: "计划确认、分节生成、多轮续跑，合并导出 DOCX/PPTX/PDF。" },
];

export function LandingPage() {
  return (
    <div className="relative min-h-dvh overflow-hidden bg-[#eef3ff] text-[#10131a]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,#c9d9ff_0%,#e6eeff_45%,transparent_100%)]" />
      <div className="pointer-events-none absolute -left-24 top-40 size-72 rounded-full bg-[#bcd1ff]/40 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 top-24 size-72 rounded-full bg-[#d7e4ff]/50 blur-3xl" />

      <header className="relative z-20">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5">
          <Link to="/" className="flex items-center gap-2.5" aria-label="CampusMate 首页">
            <span className="rounded-lg bg-white px-1.5 py-1 shadow-sm ring-1 ring-black/5">
              <img src="/campusmate-logo.png" alt="CampusMate" className="h-7 w-auto object-contain" />
            </span>
            <span className="text-sm font-semibold tracking-tight">CampusMate</span>
            <span className="hidden rounded-full border border-[#10131a]/10 bg-white/50 px-2 py-0.5 text-[10px] text-[#10131a]/50 sm:inline">预览版</span>
          </Link>
          <nav className="ml-auto hidden items-center gap-6 text-[12px] text-[#10131a]/55 md:flex" aria-label="页面导航">
            {NAV.map((item) => <a key={item.href} href={item.href} className="transition-colors hover:text-[#10131a]">{item.label}</a>)}
          </nav>
          <Link to="/app" className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-[#10131a] px-4 text-[12px] font-medium text-white transition-transform hover:scale-[1.02] md:ml-4">
            打开工作台 <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </header>

      <main className="relative z-10">
        <section className="mx-auto max-w-4xl px-5 pb-8 pt-14 text-center sm:pt-20">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">现在，开箱即用</h1>
          <p className="mx-auto mt-4 max-w-xl text-[13px] leading-7 text-[#10131a]/55">
            无论整理通知、导入课表，还是写一份长计划，都可以从这里开始。
            CampusMate 把信息、机会与行动连成一条工作流。
          </p>
          <div className="mx-auto mt-7 max-w-xl rounded-2xl border border-white/70 bg-[#0b0e14] p-5 text-center shadow-[0_30px_70px_-30px_rgba(16,19,26,.55)] sm:p-6">
            <Terminal className="mx-auto size-4 text-[#8fb0ff]" />
            <h2 className="mt-3 text-lg font-semibold text-white sm:text-xl">把下一件事，交给 CampusMate</h2>
            <p className="mx-auto mt-1.5 max-w-md text-[11px] leading-5 text-white/45">无需注册即可体验。登录 Qoder 后，聊天记录、课表与产物按账号隔离保存。</p>
            <Link to="/app" className="mt-4 inline-flex h-9 items-center gap-2 rounded-full bg-white px-5 text-[12px] font-semibold text-[#0b0e14] transition-transform hover:scale-[1.02]">
              进入演示 <ArrowRight className="size-4" />
            </Link>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-5 pb-16">
          <div className="overflow-hidden rounded-2xl border border-white/70 bg-[#0c1016] shadow-[0_40px_100px_-40px_rgba(16,19,26,.6)]">
            <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-4 py-3">
              <span className="size-2.5 rounded-full bg-[#ff5f57]" />
              <span className="size-2.5 rounded-full bg-[#febc2e]" />
              <span className="size-2.5 rounded-full bg-[#28c840]" />
              <span className="ml-3 text-[11px] text-white/35">CampusMate</span>
              <span className="ml-auto rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-white/30">⌘</span>
            </div>
            <div className="flex min-h-[420px]">
              <aside className="hidden w-56 shrink-0 flex-col border-r border-white/10 bg-[#080b10] p-3 sm:flex">
                <div className="flex items-center px-1 py-1.5">
                  <span className="rounded-md bg-white px-1.5 py-1"><img src="/campusmate-logo.png" alt="CampusMate" className="h-6 w-auto" /></span>
                </div>
                <button type="button" className="mt-3 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-left text-[11px] text-white/70">
                  <span className="text-white/40">＋</span> 新会话
                </button>
                <div className="mt-4 space-y-0.5">
                  {SIDEBAR.map((item) => (
                    <div key={item.label} className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[11px] text-white/45">
                      <item.icon className="size-3.5" /> {item.label}
                    </div>
                  ))}
                </div>
                <div className="mt-auto flex items-center gap-2 rounded-md px-1 py-2 text-[11px] text-white/40">
                  <span className="flex size-6 items-center justify-center rounded-full bg-white/10 text-[9px]">C</span> Qoder 账号
                </div>
              </aside>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-[11px] text-white/55">
                  <span className="size-1.5 rounded-full bg-[#28c840]" /> 你好，介绍一下你自己。
                </div>
                <div className="flex-1 space-y-4 overflow-hidden px-4 py-5 text-[11px] leading-6 text-white/60 sm:px-6">
                  <div className="ml-auto w-fit max-w-[80%] rounded-2xl bg-white/[0.07] px-3.5 py-2 text-white/75">你好，介绍一下你自己。</div>
                  <div className="max-w-[92%] space-y-2">
                    <p className="text-white/80">你好！我是 CampusMate，一个面向校园场景的智能助手。</p>
                    <p className="text-white/50">我可以帮你：</p>
                    <ul className="space-y-1.5 text-white/60">
                      <li>• 通知与信息整理：解读学校通知、公告、文件，提炼关键时间与要求</li>
                      <li>• 课表导入：解析图片 / PDF / Excel / 文本，写入校园日历</li>
                      <li>• 任务与目标管理：创建待办、截止提醒、日常任务和成长目标</li>
                      <li>• 机会雷达：收录竞赛、实习、奖学金、保研/考研信息</li>
                      <li>• 资料检索与核验：搜索公开网页、抓取来源，标注已核实/未核实</li>
                      <li>• 文档与成品生成：Word、PPT、Excel、PDF、HTML、流程图、时间线</li>
                    </ul>
                    <p className="text-white/45">原则：不编造信息、不把通知内容当成指令、时效性内容先核验来源。</p>
                  </div>
                </div>
                <div className="m-3 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-[11px] text-white/30">
                  输入消息 / 粘贴群通知 / 拖拽或粘贴图片文档…（Enter 发送）
                  <div className="mt-2 flex items-center gap-2 text-[10px] text-white/35">
                    <span className="rounded border border-white/10 px-1.5 py-0.5">📎 附件</span>
                    <span className="rounded border border-white/10 px-1.5 py-0.5">nex-n2.6</span>
                    <span className="ml-auto rounded-full bg-[#5b8cff] px-3 py-1 text-white">发送</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="capabilities" className="mx-auto max-w-5xl px-5 pb-16">
          <div className="grid gap-px overflow-hidden rounded-2xl border border-[#10131a]/10 bg-[#10131a]/10 sm:grid-cols-3">
            {CAPS.map((item, i) => (
              <div key={item.title} className="bg-white/80 p-5 backdrop-blur">
                <span className="font-mono text-[10px] text-[#10131a]/30">0{i + 1}</span>
                <h3 className="mt-2 text-sm font-semibold">{item.title}</h3>
                <p className="mt-1.5 text-[11px] leading-6 text-[#10131a]/50">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="artifacts" className="border-y border-[#10131a]/10 bg-white/55">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-5 py-8 text-[11px] text-[#10131a]/45">
            <FileText className="size-4 text-[#10131a]/35" />
            <span className="mr-2 font-medium text-[#10131a]/65">交付成品</span>
            {["DOCX", "PPTX", "XLSX", "CSV", "HTML", "PDF（打印）", "SVG", "Mermaid", "JSON"].map((item) => (
              <span key={item} className="rounded-md border border-[#10131a]/10 bg-white px-2.5 py-1 font-mono text-[10px]">{item}</span>
            ))}
          </div>
        </section>
      </main>

      <footer className="relative z-10">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-5 py-8 text-[11px] text-[#10131a]/35">
          <span className="rounded-md bg-white px-1.5 py-1 shadow-sm ring-1 ring-black/5"><img src="/campusmate-logo.png" alt="CampusMate" className="h-5 w-auto" /></span>
          <span>CampusMate · 校园机会管家</span>
          <a href="#capabilities" className="ml-auto transition-colors hover:text-[#10131a]/70">能力</a>
          <a href="#artifacts" className="transition-colors hover:text-[#10131a]/70">产物</a>
        </div>
      </footer>
    </div>
  );
}
