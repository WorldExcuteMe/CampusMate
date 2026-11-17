import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { NoticeClass, NoticeCategory, VerificationStatus } from "@/lib/schemas";
import { deadlineInstant, localParts } from "../../../shared/calendar";
import { useBeijingDay } from "@/lib/use-beijing-day";

const CLASS_META: Record<NoticeClass, { label: string; className: string }> = {
  must_act: { label: "必须处理", className: "bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-800" },
  high_value: { label: "高价值机会", className: "bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-200 dark:border-indigo-800" },
  worth_watching: { label: "值得关注", className: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800" },
  normal: { label: "普通信息", className: "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-950 dark:text-slate-200 dark:border-slate-800" },
  risk: { label: "风险警告", className: "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:border-rose-800" },
};

const CATEGORY_LABEL: Record<NoticeCategory, string> = {
  competition: "学科竞赛",
  internship: "实习招聘",
  research: "科研项目",
  scholarship: "奖学金",
  activity: "校园活动",
  opensource: "开源项目",
  notice: "校园通知",
};

export function ClassBadge({ value }: { value: NoticeClass }) {
  const m = CLASS_META[value];
  return <Badge variant="outline" className={cn("border", m.className)}>{m.label}</Badge>;
}

export function CategoryBadge({ value }: { value: NoticeCategory }) {
  return <Badge variant="secondary">{CATEGORY_LABEL[value]}</Badge>;
}

export function MockBadge() {
  return (
    <Badge variant="outline" className="border-dashed border-slate-300 text-slate-500">
      MOCK · 规则提取
    </Badge>
  );
}

export function DeadlineTag({ deadline, pastLabel = "已过期" }: { deadline: string | null; pastLabel?: string }) {
  const today = useBeijingDay();
  if (!deadline) return <span className="text-xs text-muted-foreground">无截止日期</span>;
  const instant = deadlineInstant(deadline, "Asia/Shanghai");
  if (!Number.isFinite(instant)) return <span className="text-xs text-muted-foreground">截止日期待核对：{deadline}</span>;
  const local = localParts(instant, "Asia/Shanghai"), date = local.date;
  const label = /T\d/.test(deadline) ? `${date} ${local.time}（北京时间）` : deadline;
  const days = Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
  const expired = instant < Date.now();
  const urgent = days <= 3;
  const soon = days <= 7;
  return (
    <span
      className={cn(
        "text-xs font-medium",
        urgent ? "text-red-600 dark:text-red-300" : soon ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
      )}
    >
      截止 {label}
      {!expired && days > 0 && ` · 剩 ${days} 天`}
      {!expired && days === 0 && " · 今天截止"}
      {expired && ` · ${pastLabel}`}
    </span>
  );
}

const VERIFY_META: Record<VerificationStatus, { label: string; className: string }> = {
  VERIFIED: { label: "已核验", className: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800" },
  PARTIALLY_VERIFIED: { label: "部分核验", className: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800" },
  UNVERIFIED: { label: "未核验", className: "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-950 dark:text-slate-200 dark:border-slate-800" },
  CONFLICTING: { label: "信息冲突", className: "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-200 dark:border-orange-800" },
  RISK_FLAGGED: { label: "风险标记", className: "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:border-rose-800" },
};

export function VerifyBadge({ value }: { value: VerificationStatus }) {
  const m = VERIFY_META[value];
  return <Badge variant="outline" className={cn("border", m.className)}>{m.label}</Badge>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-10 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
