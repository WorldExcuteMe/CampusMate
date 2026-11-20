import { Link } from "react-router-dom";
import { ArrowRight, Brain, ChevronDown, ChevronUp, Copy, Inbox, LayoutGrid, ListTodo, CalendarDays, Pencil, Paperclip, Radar, ShieldCheck, Sprout, Terminal } from "lucide-react";

const SESSIONS = ["你好，介绍一下你...", "根据课文文档生成...", "介绍qoder高校创..."];

const MODULES = [
  { icon: Inbox, label: "信息中心" },
  { icon: CalendarDays, label: "校园日历" },
  { icon: ListTodo, label: "任务与目标" },
  { icon: Radar, label: "机会中心" },
  { icon: ShieldCheck, label: "可信核验" },
  { icon: Sprout, label: "成长中心" },
];

export function LandingPage() {
  return (
    <div className="relative min-h-dvh overflow-hidden bg-[#f3f0e8] text-[#10131a]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,rgba(47,95,224,.13),transparent_38%),radial-gradient(circle_at_92%_4%,rgba(217,119,6,.10),transparent_32%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:radial-gradient(rgba(16,19,26,.14)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:linear-gradient(to_bottom,black,transparent_72%)]" />

      <header className="relative z-20">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5">
          <Link to="/" className="flex items-center gap-2.5" aria-label="CampusMate 首页">
            <span className="rounded-lg bg-white px-1.5 py-1 shadow-sm ring-1 ring-black/5">
              <img src="/campusmate-logo.png" alt="CampusMate" className="h-7 w-auto object-contain" />
            </span>
            <span className="text-sm font-semibold tracking-tight">CampusMate</span>
          </Link>
          <Link to="/app" className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-[#10131a] px-4 text-[12px] font-medium text-white transition-transform hover:scale-[1.02]">
            打开工作台 <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </header>

      <main className="relative z-10">
        <section className="mx-auto max-w-6xl px-5 pb-10 pt-14 sm:pt-20">
          <div className="grid items-center gap-10 lg:grid-cols-[1fr_360px]">
            <div>
              <p className="inline-flex items-center gap-2 text-[10px] font-medium tracking-[0.18em] text-[#10131a]/45">
                <span className="size-1.5 rounded-sm bg-[#2f5fe0]" /> CAMPUSMATE / 校园信息工作台
              </p>
              <h1 className="mt-5 max-w-2xl text-4xl font-semibold leading-[1.15] tracking-tight sm:text-5xl">
                从一条通知，
                <br />
                到
                <span className="relative mx-1 inline-block">
                  <span className="absolute inset-x-0 bottom-1 h-3 -rotate-1 bg-[#2f5fe0]/20" />
                  <span className="relative text-[#2f5fe0]">一份成品</span>
                </span>
                。
              </h1>
              <p className="mt-5 max-w-xl text-[13px] leading-7 text-[#10131a]/55">
                群聊、附件、教务系统里的信息，CampusMate 会整理成日历上的一格、待办里的一条，
                或一份能直接交的成品。
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-[#10131a]/40">
                <span>课表导入</span><span className="text-[#10131a]/20">/</span>
                <span>通知提炼</span><span className="text-[#10131a]/20">/</span>
                <span>机会跟踪</span><span className="text-[#10131a]/20">/</span>
                <span>长文与汇报</span>
              </div>
            </div>

            <div className="relative rounded-2xl border border-[#10131a]/10 bg-[#0c1016] p-6 text-left shadow-[0_26px_60px_-28px_rgba(16,19,26,.55)]">
              <span className="absolute right-5 top-5 size-2 rounded-full bg-[#e8a33d]" />
              <div className="flex items-center gap-2 text-[10px] tracking-[0.16em] text-white/35">
                <Terminal className="size-3.5 text-[#8fb0ff]" /> 从这里开始
              </div>
              <h2 className="mt-4 text-lg font-semibold leading-7 text-white">别让信息停在收藏夹里</h2>
              <p className="mt-2 text-[11px] leading-6 text-white/45">把它变成日历、待办和成品。免注册先试，登录后按账号保存。</p>
              <Link to="/app" className="mt-5 inline-flex h-9 items-center gap-2 rounded-full bg-white px-5 text-[12px] font-semibold text-[#0b0e14] transition-transform hover:scale-[1.02]">
                开始使用 <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-5 pb-14">
          <div className="overflow-hidden rounded-2xl border border-[#10131a]/10 bg-[#0c1016] shadow-[0_36px_90px_-40px_rgba(16,19,26,.65)]">
            <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-4 py-3">
              <span className="size-2.5 rounded-full bg-[#ff5f57]" />
              <span className="size-2.5 rounded-full bg-[#febc2e]" />
              <span className="size-2.5 rounded-full bg-[#28c840]" />
              <span className="ml-3 text-[11px] text-white/35">CampusMate</span>
              <div className="ml-auto flex items-center gap-1 text-[10px] text-white/35">
                <span className="rounded border border-white/10 px-2 py-0.5">自动</span>
                <span className="rounded border border-white/10 px-2 py-0.5">日常</span>
              </div>
            </div>

            <div className="flex h-[400px]">
              <aside className="relative hidden w-56 shrink-0 flex-col overflow-hidden border-r border-white/10 bg-[#080b10] p-3 pb-14 sm:flex">
                <div className="flex items-center px-1 py-1">
                  <span className="rounded-md bg-white px-1.5 py-1"><img src="/campusmate-logo.png" alt="CampusMate" className="h-6 w-auto" /></span>
                </div>
                <div className="mt-3 flex items-center gap-2 rounded-md px-2.5 py-2 text-[11px] text-white/65">
                  <LayoutGrid className="size-3.5" /> Today
                </div>
                <div className="mt-1 flex items-center gap-2 rounded-md px-2.5 py-2 text-[11px] text-white/55">
                  <Terminal className="size-3.5" /> 智能体工作台 <ChevronUp className="ml-auto size-3 text-white/30" />
                </div>
                <div className="mt-0.5 space-y-0.5 border-l border-white/10 pl-2">
                  {SESSIONS.map((item) => (
                    <div key={item} className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] text-white/35">
                      <span className="text-white/25">□</span> {item}
                    </div>
                  ))}
                  <div className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[10px] text-white/55">
                    <span className="text-[#8fb0ff]">＋</span> 新会话
                  </div>
                </div>
                <div className="mt-2 space-y-0.5">
                  {MODULES.map((item) => (
                    <div key={item.label} className="flex items-center gap-2 rounded-md px-2.5 py-0 text-[11px] text-white/45">
                      <item.icon className="size-3.5" /> {item.label}
                    </div>
                  ))}
                </div>
                <div className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-md border-t border-white/10 bg-[#080b10] px-1 pb-1 pt-2">
                  <span className="flex size-7 items-center justify-center rounded-full bg-[#2f5fe0] text-[10px] text-white">C</span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-white/80">CampusMate</p>
                    <p className="text-[9px] text-white/35">Qoder 账号</p>
                  </div>
                  <ChevronDown className="ml-auto size-3 text-white/25" />
                </div>
              </aside>

              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
                  <span className="text-[11px] text-white/70">你好，介绍一下你自己。</span>
                  <Pencil className="size-3 text-white/25" />
                  <span className="ml-auto text-[10px] text-white/25 sm:hidden">日常</span>
                </div>
                <div className="flex-1 space-y-3 overflow-hidden px-4 py-4 text-[10.5px] leading-5 text-white/60 sm:px-6">
                  <div className="ml-auto w-fit max-w-[80%] rounded-2xl bg-white/[0.07] px-3.5 py-2 text-white/75">你好，介绍一下你自己。</div>
                  <div className="max-w-[94%] space-y-1.5">
                    <div className="flex items-center gap-1.5 text-[10px] text-white/30"><Brain className="size-3" /> 思考摘要 · 1 段 <ChevronDown className="size-3" /> <Copy className="ml-1 size-3 text-white/20" /></div>
                    <p className="flex items-start gap-2 text-white/80"><Terminal className="mt-1 size-3.5 shrink-0 text-[#8fb0ff]" /> 你好！我是 CampusMate 的服务端模型执行器，一个面向校园场景的智能助手。</p>
                    <p className="text-white/50">我可以帮你做这些事：</p>
                    <ul className="space-y-1 text-white/55">
                      <li>• 通知与信息整理：解读通知、公告、文件，提炼关键时间与要求</li>
                      <li>• 课表导入：解析图片 / PDF / Excel / 文本，写入校园日历</li>
                      <li>• 任务与目标管理：创建待办、截止提醒、日常任务和成长目标</li>
                      <li>• 机会雷达：收录竞赛、实习、奖学金、保研/考研信息，并跟踪截止时间</li>
                      <li>• 资料检索与核验：搜索公开网页、抓取来源，标注“已核实 / 未核实”</li>
                      <li>• 文档与成品生成：Word、PPT、Excel、PDF、HTML、流程图、时间线</li>
                    </ul>
                    <p className="text-white/45">我的原则是：不编造信息、不把通知内容当成指令、时效性内容先核验来源。有课表要导入、通知要看、竞赛要跟踪，或想做一份计划/汇报材料，直接发给我就可以。</p>
                  </div>
                </div>
                <div className="m-3 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-[11px] text-white/30">
                  输入消息 / 粘贴群通知 / 拖拽或粘贴图片文档…（Enter 发送）
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-white/40">
                    <span className="inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5"><Paperclip className="size-3" /> 附件限制</span>
                    <span className="rounded border border-white/10 px-1.5 py-0.5">nex-n2.6</span>
                    <span className="rounded border border-white/10 px-1.5 py-0.5">思考 自动</span>
                    <span className="ml-auto rounded bg-[#5b8cff] px-3 py-1 text-white">发送</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-3 text-[9px] text-white/25">
                    <span>1% 2.4K/262.1K</span>
                    <span>2.7K tok · 1 轮 · 0 步</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-[#10131a]/10">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-6 text-[11px] text-[#10131a]/35">
          <span className="rounded-md bg-white px-1.5 py-1 shadow-sm ring-1 ring-black/5"><img src="/campusmate-logo.png" alt="CampusMate" className="h-5 w-auto" /></span>
          <span>CampusMate · 校园机会管家</span>
          <span className="ml-auto hidden text-[#10131a]/25 sm:inline">信息本位 · 机会雷达</span>
        </div>
      </footer>
    </div>
  );
}
