import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ChevronUp, GraduationCap, LogIn, LogOut, Settings, UserRound } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { useRepository } from "@/app/auth";
import { signOut, useAuth } from "@/app/auth";
import { cn } from "@/lib/utils";

// 左下角已登录用户芯片：头像+名字，展开显示画像摘要与设置/退出入口（DSH 左下角用户区理念）。
export function UserChip() {
  const repository = useRepository();
  const { session, configured } = useAuth();
  const nav = useNavigate();
  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: () => repository.getProfile() });
  const name = session?.user?.email?.split("@")[0] || profile?.name || "演示用户";
  const initial = (name || "U").slice(0, 1).toUpperCase();
  const sub = session ? session.user?.email : "Demo · 本地演示数据";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "group flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left",
            "transition-all hover:border-ring/40 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98]",
          )}
          aria-label="用户与设置"
        >
          <Avatar className="size-8 shrink-0 ring-1 ring-border">
            <AvatarFallback className="bg-primary/15 text-sm font-semibold text-primary">{initial}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-sidebar-foreground">{name}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
          </span>
          <ChevronUp className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <Avatar className="size-10 ring-1 ring-border">
            <AvatarFallback className="bg-primary/15 text-base font-semibold text-primary">{initial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{sub}</p>
          </div>
        </div>
        <Separator />
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-4 py-3 text-xs">
          <span className="text-muted-foreground">专业</span>
          <span className="truncate text-right font-medium">{profile?.major || "—"}</span>
          <span className="text-muted-foreground">年级</span>
          <span className="truncate text-right font-medium">{profile?.grade || "—"}</span>
          <span className="text-muted-foreground">兴趣</span>
          <span className="truncate text-right font-medium">{profile?.interests?.slice(0, 2).join("、") || "—"}</span>
          <span className="text-muted-foreground">目标</span>
          <span className="truncate text-right font-medium">{profile?.goals?.slice(0, 1).join("") || "—"}</span>
        </div>
        <Separator />
        <div className="flex flex-col p-1.5">
          <button
            className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-muted"
            onClick={() => nav("/app/profile")}
          >
            <UserRound className="size-4 text-muted-foreground" /> 个人画像
          </button>
          <button
            className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-muted"
            onClick={() => nav("/app/settings")}
          >
            <Settings className="size-4 text-muted-foreground" /> 设置
          </button>
          {session ? (
            <button
              className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-destructive hover:bg-destructive/10"
              onClick={() => signOut()}
            >
              <LogOut className="size-4" /> 退出登录
            </button>
          ) : (
            configured && (
              <button
                className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-muted"
                onClick={() => nav("/login")}
              >
                <LogIn className="size-4 text-muted-foreground" /> 登录 / 注册
              </button>
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <span className="cm-glow flex size-8 items-center justify-center rounded-lg bg-primary/15">
        <GraduationCap className="size-4.5 text-primary" />
      </span>
      <span className="text-base font-semibold tracking-tight">
        Campus<span className="cm-gradient-text">Mate</span>
      </span>
    </span>
  );
}