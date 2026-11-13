import { useState } from "react";
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Inbox,
  Radar,
  ShieldCheck,
  Sprout,
  User,
  Settings,
  GraduationCap,
  Bot,
  CalendarClock,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { signOut, useAuth } from "./auth";
import { useSessions } from "@/lib/agent/sessions-context";

const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/agent", label: "会话", icon: Bot },
  { to: "/app/inbox", label: "Inbox", icon: Inbox },
  { to: "/app/daily", label: "日常任务", icon: CalendarClock },
  { to: "/app/radar", label: "机会雷达", icon: Radar },
  { to: "/app/trust", label: "可信核验", icon: ShieldCheck },
  { to: "/app/growth", label: "成长中心", icon: Sprout },
  { to: "/app/profile", label: "个人画像", icon: User },
  { to: "/app/settings", label: "设置", icon: Settings },
];

export function Layout() {
  const { session, configured } = useAuth();
  const { sessions, activeId, setActiveId, create, remove } = useSessions();
  const nav = useNavigate();
  const loc = useLocation();
  const [expand, setExpand] = useState(loc.pathname.startsWith("/app/agent"));
  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <GraduationCap className="size-6 text-primary" />
          <span className="text-lg font-semibold tracking-tight">CampusMate</span>
        </div>
        <nav className="flex flex-col gap-1 px-3">
          {NAV.map((item) =>
            item.to === "/app/agent" ? (
              <div key={item.to}>
                <button
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    loc.pathname.startsWith("/app/agent")
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
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
                          "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                          s.id === activeId ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-muted",
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
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                      onClick={() => { create(); nav("/app/agent"); }}
                    >
                      <Plus className="size-3" /> 新会话
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                <item.icon className="size-4" />
                {item.label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="mt-auto flex flex-col gap-1 px-3 py-4">
          <NavLink
            to="/app/settings"
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <SlidersHorizontal className="size-4" />
            Agent 设置 / 调优
          </NavLink>
          <p className="px-3 text-xs text-muted-foreground">校园机会管家 · MVP</p>
          {configured && !session && (
            <NavLink
              to="/login"
              className="mt-1 px-3 text-left text-xs text-muted-foreground hover:text-foreground"
            >
              登录 / 注册（真实模式）
            </NavLink>
          )}
          {session && (
            <button
              className="mt-1 px-3 text-left text-xs text-muted-foreground hover:text-foreground"
              onClick={() => signOut()}
            >
              退出登录
            </button>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-3 md:hidden">
          <GraduationCap className="size-5 text-primary" />
          <span className="font-semibold">CampusMate</span>
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
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800">
            演示模式（Demo）：预设虚拟数据，AI 结果为明确标识的 Mock，非真实模型/实时检索。
            {configured ? "登录后可启用真实用户模式。" : "配置 Supabase 后启用真实用户模式。"}
          </div>
        )}

        <main className="min-w-0 flex-1 p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}