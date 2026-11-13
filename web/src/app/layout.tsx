import { useState } from "react";
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard, Inbox, Radar, ShieldCheck, Sprout, Bot, CalendarClock,
  ChevronDown, ChevronRight, MessageSquare, Plus, Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "./auth";
import { useSessions } from "@/lib/agent/sessions-context";
import { UserChip, BrandMark } from "@/components/UserChip";

const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/agent", label: "会话", icon: Bot },
  { to: "/app/inbox", label: "Inbox", icon: Inbox },
  { to: "/app/daily", label: "日常任务", icon: CalendarClock },
  { to: "/app/radar", label: "机会雷达", icon: Radar },
  { to: "/app/trust", label: "可信核验", icon: ShieldCheck },
  { to: "/app/growth", label: "成长中心", icon: Sprout },
];

const navItem = (active: boolean) =>
  cn(
    "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all",
    active
      ? "bg-sidebar-accent text-sidebar-foreground shadow-[inset_2px_0_0_0_var(--sidebar-primary)]"
      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
  );

export function Layout() {
  const { session, configured } = useAuth();
  const { sessions, activeId, setActiveId, create, remove } = useSessions();
  const nav = useNavigate();
  const loc = useLocation();
  const [expand, setExpand] = useState(loc.pathname.startsWith("/app/agent"));

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="px-4 py-4">
          <BrandMark />
          <p className="mt-1 pl-10 text-[11px] text-muted-foreground">校园机会管家 · Agent</p>
        </div>
        <nav className="flex flex-col gap-1 px-3">
          {NAV.map((item) =>
            item.to === "/app/agent" ? (
              <div key={item.to}>
                <button
                  className={cn(navItem(loc.pathname.startsWith("/app/agent")), "w-full")}
                  onClick={() => { setExpand((e) => !e); nav("/app/agent"); }}
                >
                  <item.icon className="size-4" />
                  {item.label}
                  {expand ? <ChevronDown className="ml-auto size-3.5" /> : <ChevronRight className="ml-auto size-3.5" />}
                </button>
                {expand && (
                  <div className="mt-1 flex flex-col gap-0.5 pl-4">
                    {sessions.map((s) => (
                      <div
                        key={s.id}
                        className={cn(
                          "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                          s.id === activeId ? "bg-sidebar-accent text-sidebar-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60",
                        )}
                        onClick={() => { setActiveId(s.id); nav("/app/agent"); }}
                      >
                        <MessageSquare className="size-3 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        <button
                          className="hidden shrink-0 group-hover:block"
                          aria-label="删除会话"
                          onClick={(e) => { e.stopPropagation(); remove(s.id); }}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    ))}
                    <button
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent/60"
                      onClick={() => { create(); nav("/app/agent"); }}
                    >
                      <Plus className="size-3" /> 新会话
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => navItem(isActive)}>
                <item.icon className="size-4" />
                {item.label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="mt-auto flex flex-col gap-2 border-t border-sidebar-border px-3 py-3">
          <UserChip />
          <p className="px-1 text-[10px] text-muted-foreground">CampusMate · 信息本位 · 机会雷达</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-3 md:hidden">
          <BrandMark />
          <div className="ml-auto w-44 shrink-0"><UserChip /></div>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b border-border bg-card px-2 py-2 md:hidden">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium",
                  isActive ? "bg-secondary text-secondary-foreground" : "text-muted-foreground",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        {!session && (
          <div className="border-b border-info/20 bg-info/10 px-4 py-2 text-center text-xs text-info">
            演示模式（Demo）：预设虚拟数据，AI 结果为明确标识的 Mock，非真实模型/实时检索。
            {configured ? "登录后可启用真实用户模式。" : "配置 Supabase 后启用真实用户模式。"}
          </div>
        )}

        <main className="cm-aurora min-w-0 flex-1 p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
