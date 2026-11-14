import { Link } from "react-router-dom";
import { ArrowUpRight, FileText, ShieldAlert, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClassBadge, CategoryBadge, DeadlineTag, MockBadge } from "@/components/shared";
import type { InboxItem } from "@/lib/data/types";
import { publicSourceUrl } from "../../../../shared/document";

export const INBOX_STATUS: Record<string, string> = { pending_review: "待确认", confirmed: "已确认", archived: "已归档", ignored: "已忽略" };
export function InboxPreview({ item }: { item: InboxItem }) {
  const e = item.extracted, source = publicSourceUrl(item.sourceUrl ?? e.sourceUrl);
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-2"><ClassBadge value={item.classification.class} /><CategoryBadge value={e.category} />{item.demo && <MockBadge />}</div>
    <div><h2 className="text-xl font-semibold leading-relaxed tracking-tight">{e.title}</h2><p className="mt-3 text-sm leading-7 text-muted-foreground">{e.summary || "尚无结构化摘要，可先查看原文。"}</p></div>
    <div className="space-y-3 rounded-xl bg-muted/40 p-4"><div className="flex items-start gap-2"><CalendarClock className="mt-0.5 size-4 shrink-0 text-primary" /><DeadlineTag deadline={e.deadline} /></div><dl className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-2 text-xs leading-5"><dt className="text-muted-foreground">发布方</dt><dd className="break-words">{e.org || "待核对"}</dd><dt className="text-muted-foreground">地点</dt><dd>{e.location || "未注明"}</dd><dt className="text-muted-foreground">当前状态</dt><dd>{INBOX_STATUS[item.status] ?? "待处理"}</dd>{e.cost && <><dt className="text-muted-foreground">参与成本</dt><dd>{e.cost}</dd></>}</dl></div>
    {item.classification.priorityReason && <div><h3 className="mb-2 text-xs font-semibold text-muted-foreground">为什么值得看</h3><p className="text-sm leading-6">{item.classification.priorityReason}</p></div>}
    {item.classification.riskSignals.length > 0 && <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"><p className="mb-1 flex items-center gap-2 font-semibold"><ShieldAlert className="size-4" />需要核对的风险</p><ul className="list-disc space-y-1 pl-5">{item.classification.riskSignals.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
    {(e.conditions.length > 0 || e.materials.length > 0) && <div className="space-y-3">{[["参与条件", e.conditions], ["所需材料", e.materials]].map(([label, values]) => (values as string[]).length > 0 && <div key={label as string}><h3 className="text-xs font-semibold text-muted-foreground">{label as string}</h3><ul className="mt-2 list-disc space-y-1 pl-4 text-sm">{(values as string[]).map((v, i) => <li key={i}>{v}</li>)}</ul></div>)}</div>}
    <section><h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground"><FileText className="size-3.5" />原文记录</h3><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-dashed bg-background p-3 font-sans text-xs leading-6">{item.rawText || "暂无原文"}</pre></section>
    <div className="flex flex-wrap items-center gap-2 border-t pt-4"><Button asChild className="min-w-0"><Link to={`/app/inbox/${item.id}`}>查看详情并处理<ArrowUpRight className="size-4" /></Link></Button>{source && <Button asChild variant="ghost"><a href={source} target="_blank" rel="noreferrer">打开来源<ArrowUpRight className="size-3.5" /></a></Button>}</div>
  </div>;
}
