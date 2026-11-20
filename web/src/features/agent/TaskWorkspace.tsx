import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, Clock3, Loader2, PanelRightClose, PanelRightOpen, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cancelTask, decideApproval, getTask, listApprovals, resumeTask, type AgentTask } from "@/lib/agent/api-client";
import type { ChatSession } from "@/lib/agent/sessions";
import { taskReason } from "@/lib/agent/task-state";
import { errorMessage } from "@/lib/llm/errors";
import { DocumentArtifacts } from "./DocumentArtifacts";
import { ArtifactsPanel } from "./ArtifactPreview";

const statuses: Record<string, string> = { queued: "排队中", running: "正在执行", paused: "已暂停", needs_input: "等待处理", succeeded: "已完成", failed: "未完成", cancelled: "已取消" };
const tools: Record<string, string> = { web_search: "检索公开资料", web_fetch: "核对网页来源", read_artifact: "读取完整材料", save_opportunity: "保存机会", save_to_inbox: "保存通知到信息中心", propose_verification: "提交核验提案", document_create: "生成文档", document_export: "导出文件", document_inspect: "检查文档" };
const reasons: Record<string, string> = { approval_pending: "需要你的审批", budget_exceeded: "需要调整预算", output_incomplete: "输出未完成，草稿已保留", persistence_failed: "记录保存失败，可恢复重试", execution_interrupted: "执行中断，可恢复或取消", missing_information: "需要补充材料" };
const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)}毫秒` : ms < 60000 ? `${(ms / 1000).toFixed(1)}秒` : `${Math.floor(ms / 60000)}分${Math.round(ms / 1000) % 60}秒`;
function sources(value: unknown): { url: string; host: string }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((raw) => { try { const url = new URL(String(raw)); return ["http:", "https:"].includes(url.protocol) ? [{ url: url.toString(), host: url.hostname }] : []; } catch { return []; } });
}

export function TaskWorkspace({ session, sending = false, onSelect, onTask, onRefresh, onContinue, loadError, width = 320, collapsed = false, onWidth, onToggle }: { session: ChatSession; sending?: boolean; onSelect: (id: string) => void; onTask: (task: AgentTask) => void; onRefresh: () => void; onContinue: (title: string) => void; loadError?: string; width?: number; collapsed?: boolean; onWidth?: (w: number) => void; onToggle?: () => void }) {
  const [tab, setTab] = useState<"steps" | "artifacts" | "context">("steps");
  const views = Object.values(session.taskViews ?? {}).sort((a, b) => (b.task.turnSeq ?? 0) - (a.task.turnSeq ?? 0) || (b.task.createdAt ?? 0) - (a.task.createdAt ?? 0));
  const selected = views.find((v) => v.task.id === session.currentTaskId);
  // 自动跳转到正在进行的轮次：选中轮次已结束且存在进行中任务时优先展示进行中任务。
  const view = selected && ["queued", "running"].includes(selected.task.status) ? selected : views.find((v) => ["queued", "running"].includes(v.task.status)) ?? selected ?? views[0];
  const submitting = sending && Boolean(session.pendingTurn && !session.pendingTurn.taskId);
  const [expanded, setExpanded] = useState(() => typeof window === "undefined" || window.innerWidth >= 1024);
  const unfinished = view && ["queued", "running"].includes(view.task.status) ? [...view.events].reverse().find((event) => event.type === "tool.called" && !view.events.some((end) => end.seq > event.seq && end.type === "tool.result" && end.payload.callInstanceId === event.payload.callInstanceId)) : undefined;
  function startResize(e: { preventDefault: () => void; clientX: number }) {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    const move = (ev: PointerEvent) => onWidth?.(Math.min(560, Math.max(280, startW + (startX - ev.clientX))));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  if (collapsed) return <aside aria-label="任务执行面板（已收起）" className="hidden w-10 shrink-0 flex-col items-center border-l border-border bg-muted/20 py-2 lg:flex"><button type="button" aria-label="展开任务面板" title="展开任务面板" onClick={onToggle} className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><PanelRightOpen className="size-4" /></button></aside>;
  return <aside aria-label="任务执行面板" style={{ width }} className="relative hidden shrink-0 border-l border-border bg-muted/20 lg:block">
    <div role="separator" aria-label="拖拽调整侧边栏宽度" title="拖拽调整宽度" onPointerDown={startResize} className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-primary/40" />
    <details open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)} className="h-full">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-semibold">执行进度 <span className="ml-1 truncate text-xs font-normal text-muted-foreground">{submitting ? "正在提交新任务" : unfinished ? tools[String(unfinished.payload.name)] ?? "执行工具中" : view ? statuses[view.task.status] : "等待新任务"}</span><button type="button" aria-label="收起任务面板" title="收起" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle?.(); }} className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><PanelRightClose className="size-4" /></button></summary>
      <div role="tablist" aria-label="执行面板分区" className="mb-2 flex gap-1 border-b border-border/60 px-3 pb-2">
        {([["steps", "工作步骤"], ["artifacts", "产物"], ["context", "上下文"]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={`rounded-md px-2.5 py-1 text-xs transition-colors ${tab === id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted"}`} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <div className="max-h-80 space-y-4 overflow-y-auto px-4 pb-5 lg:max-h-[calc(100dvh-18rem)]">
        {submitting && <p role="status" className="text-xs leading-5 text-primary">正在提交，尚未收到后端确认；以下为已有任务记录。</p>}
        {loadError && <div role="alert" className="text-xs text-destructive">任务状态加载失败：{loadError}<Button size="sm" variant="ghost" onClick={onRefresh}>重试加载</Button></div>}
        {views.length > 1 && <TurnPicker views={views} current={view?.task.id} onSelect={onSelect} />}
        {view ? (tab === "context" ? <ContextTab session={session} task={view.task} events={view.events} /> : <div className={tab === "steps" ? "" : "hidden"}><TaskDetails key={view.task.id} view={view} resumeBlocked={view.task.status === "failed" && views.some(v => v.task.id !== view.task.id && ((v.task.turnSeq ?? 0) > (view.task.turnSeq ?? 0) || !(v.task.turnSeq && view.task.turnSeq) && (v.task.createdAt ?? 0) > (view.task.createdAt ?? 0)))} onTask={onTask} onRefresh={onRefresh} onContinue={onContinue} /></div>) : <p className="text-xs leading-6 text-muted-foreground">发送消息后，这里会显示排队、资料检索、工具结果和产物检查。</p>}
        {view && tab === "artifacts" && (view.task.result?.artifactIds.length ? <ArtifactsPanel ids={view.task.result.artifactIds} owner={view.task.userId} /> : <p className="text-xs leading-6 text-muted-foreground">本轮还没有生成文档产物。生成后可在这里预览与下载。</p>)}
      </div>
    </details>
  </aside>;
}

function TurnPicker({ views, current, onSelect }: { views: Array<{ task: AgentTask }>; current?: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const active = views.find(v => v.task.id === current) ?? views[0];
  return <div className="relative">
    <button type="button" aria-label="查看任务记录" aria-expanded={open} onClick={() => setOpen(v => !v)} className="flex h-9 w-full items-center gap-2 rounded-md border bg-background px-2 text-xs hover:bg-muted">
      <span className={`size-2 shrink-0 rounded-full ${active?.task.status === "succeeded" ? "bg-emerald-500" : active?.task.status === "failed" ? "bg-red-500" : active && ["queued", "running"].includes(active.task.status) ? "bg-primary animate-pulse" : "bg-muted-foreground"}`} />
      <span className="truncate">{active ? `${statuses[active.task.status]} · ${active.task.title}` : "选择任务"}</span>
      <span className="ml-auto text-muted-foreground">{open ? "▲" : "▼"}</span>
    </button>
    {open && <div role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover shadow-md">{views.map(({ task }) => <button key={task.id} type="button" role="option" aria-selected={task.id === current} onClick={() => { onSelect(task.id); setOpen(false); }} className={`flex w-full items-center gap-2 px-2 py-2 text-left text-xs hover:bg-muted ${task.id === current ? "bg-primary/10 text-primary" : ""}`}><span className={`size-2 shrink-0 rounded-full ${task.status === "succeeded" ? "bg-emerald-500" : task.status === "failed" ? "bg-red-500" : ["queued", "running"].includes(task.status) ? "bg-primary" : "bg-muted-foreground"}`} /><span className="truncate">{statuses[task.status]} · {task.title}</span></button>)}</div>}
  </div>;
}
function ContextTab({ session, task, events }: { session: ChatSession; task: AgentTask; events: Array<{ type: string; payload: Record<string, unknown> }> }) {
  const last = task.modelRuntime?.lastRequest;
  const turns = events.filter((e) => e.type === "llm.request").length;
  const steps = events.filter((e) => e.type === "tool.called").length;
  const usage = last?.usage;
  const cacheHit = usage?.cacheRead != null && usage?.inputTotal ? Math.round((usage.cacheRead / usage.inputTotal) * 100) : null;
  const cap = task.promptUsage?.contextLimit ?? session.contextCap ?? null;
  const used = task.promptUsage?.inputTokens ?? session.contextUsed ?? null;
  const rows: Array<[string, string]> = [
    ["上下文占用", used == null || cap == null ? "未知" : `${Math.round((used / cap) * 100)}% · ${used.toLocaleString()} / ${cap.toLocaleString()} tok`],
    ["模型", task.modelRuntime?.actualModel ?? "未知"],
    ["轮次 / 工具步数", `${turns} 轮 · ${steps} 步`],
    ["首 token 延迟", last?.ttftMs == null ? "未知" : `${(last.ttftMs / 1000).toFixed(2)} 秒`],
    ["最近请求耗时", last == null ? "未知" : `${(last.totalMs / 1000).toFixed(1)} 秒`],
    ["累计 token", (task.usage?.tokens ?? 0).toLocaleString()],
    ["缓存命中", cacheHit == null ? "暂无" : `${cacheHit}%`],
    ["最近请求输入/输出", usage ? `${usage.inputTotal ?? "?"} / ${usage.output ?? "?"} tok` : "未知"],
    ["最近思考 token", usage?.reasoning == null ? "未知" : String(usage.reasoning)],
    ["思考强度", last?.reasoning ? `${last.reasoning.effective ?? "不可调"}（${last.reasoning.reason}）` : "未知"],
    ["费用", usage?.costUsd == null ? "未知" : `$${usage.costUsd.toFixed(6)}`],
    ["压缩 / 截断", `${session.compressed ? "已压缩" : "未压缩"} · ${session.pruned ? "已截断旧工具结果" : "未截断"}`],
  ];
  return <div className="space-y-2" aria-label="上下文与用量">
    <p className="text-xs text-muted-foreground">这里的数值来自后端上报与最近请求；未知项不做估算占位。</p>
    <dl className="divide-y divide-border/60 rounded-lg border border-border/70 bg-background">
      {rows.map(([label, value]) => <div key={label} className="flex items-baseline justify-between gap-3 px-3 py-2 text-xs"><dt className="text-muted-foreground">{label}</dt><dd className="break-all text-right font-medium tabular-nums">{value}</dd></div>)}
    </dl>
  </div>;
}
function TaskDetails({ view, resumeBlocked, onTask, onRefresh, onContinue }: { view: NonNullable<ChatSession["taskViews"]>[string]; resumeBlocked: boolean; onTask: (task: AgentTask) => void; onRefresh: () => void; onContinue: (title: string) => void }) {
  const { task, events } = view;
  const local = task.id.startsWith("local:");
  const reason = taskReason(task, events), active = ["queued", "running"].includes(task.status);
  const [clock, setClock] = useState(Date.now());
  const [action, setAction] = useState(""), [error, setError] = useState("");
  const [tokens, setTokens] = useState(task.budget?.tokens ?? 200000), [calls, setCalls] = useState(task.budget?.toolCalls ?? 40), [minutes, setMinutes] = useState((task.budget?.wallMs ?? 600000) / 60000);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  const approvals = useQuery({ queryKey: ["approvals", task.userId, task.id], queryFn: listApprovals, enabled: !local && task.status === "needs_input" });
  const pendingApprovals = task.status === "needs_input" ? (approvals.data ?? []).filter((a) => a.taskId === task.id) : [];
  const act = async (kind: string, work: () => Promise<void>) => { setAction(kind); setError(""); try { await work(); onTask(await getTask(task.id)); onRefresh(); } catch (e) { setError(errorMessage(e)); } finally { setAction(""); } };
  const starts = events.filter((event) => event.type === "tool.called").slice(-16);
  const thinkingSummaries = events.filter((event) => event.type === "thinking.summary").slice(-4);
  const lastRequest = task.modelRuntime?.lastRequest;
  const lastLlm = [...events].reverse().find((e) => ["llm.request", "llm.response"].includes(e.type));
  const connection: Record<string, string> = { connecting: "正在连接进度", live: "实时连接", polling: "正在同步进度", offline: "连接暂不可用，将继续重连", closed: "记录已同步" };
  return <>
    <div className="rounded-lg border border-border/70 bg-background p-3">
      {local && <p className="mb-2 text-xs text-muted-foreground">浏览器开发记录 · 服务端恢复与验收未启用</p>}
      <p className="break-words text-sm font-medium">{task.title}</p>
      <p role="status" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">{active ? <Loader2 className="size-3.5 animate-spin text-primary" /> : task.status === "succeeded" ? <CheckCircle2 className="size-3.5 text-emerald-600" /> : <Clock3 className="size-3.5" />}{task.cancelRequested && active ? "正在取消，等待当前调用结束" : statuses[task.status]}</p>
      <p className="mt-2 text-xs text-muted-foreground">{local ? active ? "浏览器正在执行" : "本地记录已更新" : connection[view.connection ?? "connecting"]}{task.createdAt && active ? ` · 已提交${duration(Math.max(0, clock - task.createdAt))}` : ""}</p>
      {task.status === "queued" && <p className="mt-2 text-xs text-muted-foreground">等待Worker处理；同会话前轮未结束时会保持顺序。</p>}
      {active && lastLlm?.type === "llm.request" && <p className="mt-2 text-xs text-primary">模型正在生成或判断下一步…</p>}
      {task.status !== "succeeded" && (reasons[reason] || task.error) && <p className="mt-2 text-xs leading-5">{reasons[reason] ?? task.error}</p>}
    </div>
    {starts.length > 0 && <ol aria-label="工具执行记录" className="space-y-3 border-l border-primary/20 pl-3">{starts.map((start) => {
      const result = events.find((e) => e.seq > start.seq && e.type === "tool.result" && e.payload.callInstanceId === start.payload.callInstanceId);
      const ok = result?.payload.ok, waiting = String(result?.payload.summary ?? "").includes("审批");
      const recovered = events.some(e => e.type === 'tool.recovered' && e.payload.callInstanceId === start.payload.callInstanceId);
      const warning = Boolean(result?.payload.warning);
      const Icon = !result ? Circle : recovered || warning || waiting ? Clock3 : ok ? CheckCircle2 : XCircle;
      return <li key={start.seq} className="rounded-lg border border-border/60 bg-background p-2 text-xs"><div className="flex items-start gap-2"><Icon className={`mt-0.5 size-3.5 shrink-0 ${recovered || warning ? 'text-amber-600' : ok ? "text-emerald-600" : result && !waiting ? "text-destructive" : "text-primary"}`} /><div className="min-w-0"><p>{tools[String(start.payload.name)] ?? String(start.payload.name)}{Boolean(start.payload.resumed) && <span className="ml-1 text-muted-foreground">继续</span>}</p><p className="mt-1 leading-5 text-muted-foreground">{recovered ? '首次失败，后续同一操作已重试成功；原始记录保留' : result ? String(result.payload.summary ?? (ok ? "完成" : "未完成")) : active ? "正在执行" : "已停止"}{typeof result?.payload.durationMs === "number" ? ` · ${duration(result.payload.durationMs)}` : ""}</p>{typeof start.payload.argsSummary === "string" && start.payload.argsSummary ? <p className="mt-1 truncate text-[11px] text-muted-foreground">参数 · {start.payload.argsSummary}</p> : null}{sources(result?.payload.sourceUrls).map(({ url, host }) => <a key={url} href={url} target="_blank" rel="noreferrer" className="mt-1 block truncate text-primary underline underline-offset-2">来源 · {host}</a>)}</div></div></li>;
    })}</ol>}
    {thinkingSummaries.length > 0 && <details className="rounded-lg border border-border/60 bg-muted/20 p-2 text-xs"><summary className="cursor-pointer text-muted-foreground">思考摘要 · {thinkingSummaries.length} 段（自动截取，非完整推理）</summary><div className="mt-2 space-y-2">{thinkingSummaries.map((event) => <div key={event.seq}><p className="leading-5">{String(event.payload.excerpt ?? "已思考")}</p><p className="mt-1 text-[11px] text-muted-foreground">{typeof event.payload.chars === "number" ? `约 ${event.payload.chars} 字` : ""}{event.payload.truncated ? " · 已截断" : ""}{typeof event.payload.durationMs === "number" ? ` · ${duration(event.payload.durationMs)}` : ""}</p></div>)}</div></details>}
    {view.draft && active && !/^\s*(\{|```json)/i.test(view.draft) && <div className="rounded-lg bg-primary/5 p-3"><p className="mb-2 text-xs font-medium text-primary">正在生成 · 尚未完成</p><p className="max-h-36 overflow-auto whitespace-pre-wrap text-xs leading-6">{view.draft}</p></div>}
    {lastRequest && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">请求与用量</summary><div className="mt-2 space-y-1 leading-5 text-muted-foreground"><p>尝试 {lastRequest.attempts} 次 · 首字 {lastRequest.ttftMs === null ? "未知" : duration(lastRequest.ttftMs)} · 最近请求耗时 {duration(lastRequest.totalMs)}</p>{["succeeded", "failed", "cancelled"].includes(task.status) && task.createdAt !== undefined && task.updatedAt !== undefined && <p>任务从提交到结束：{duration(Math.max(0, task.updatedAt - task.createdAt))}</p>}<p>输入 {lastRequest.usage.inputTotal ?? "未知"} · 输出 {lastRequest.usage.output ?? "未知"} · 缓存读取 {lastRequest.usage.cacheRead ?? "未知"}</p><p>思考 {lastRequest.reasoning.effective ?? "不可调节"} · {lastRequest.reasoning.reason}</p><p>费用 {lastRequest.usage.costUsd === null ? "未知" : `$${lastRequest.usage.costUsd}`}</p></div></details>}
    {task.result?.completion?.checks?.length ? <ul className="space-y-1 text-xs">{task.result.completion.checks.map((check) => <li key={check.id}>{check.passed ? "✓" : "待完善"} {check.detail ?? check.id}</li>)}</ul> : null}
    {events.some((e) => e.type === "step.started" && e.payload.title) && <ol aria-label="文档执行阶段" className="space-y-2 text-xs">{events.filter((e) => e.type === "step.started" && e.payload.title).filter((e, i, all) => all.findIndex((v) => v.payload.stepId === e.payload.stepId) === i).map((start) => { const end = [...events].reverse().find((e) => e.type === "step.finished" && e.payload.stepId === start.payload.stepId); return <li key={start.seq} className="flex items-start gap-2"><span className={end?.payload.passed ? "text-teal-600" : "text-muted-foreground"}>{end ? end.payload.passed ? "✓" : "待完善" : "进行中"}</span><span>{String(start.payload.title)}</span></li>; })}</ol>}
    {task.result?.artifactIds.length ? <DocumentArtifacts ids={task.result.artifactIds} owner={task.userId} partial={task.result.completion?.state !== "complete"} /> : null}
    {pendingApprovals.map((approval) => <div key={approval.id} className="rounded-lg border border-amber-300/50 bg-amber-50/30 p-3 text-xs dark:bg-amber-950/10"><p className="font-medium">等待审批 · {tools[approval.toolName] ?? approval.toolName}</p><p className="mt-1 leading-5 text-muted-foreground">{approval.risk}</p><div className="mt-2 flex gap-2"><Button size="sm" disabled={Boolean(action)} onClick={() => act("approval", async () => { await decideApproval(approval.id, "approved"); await resumeTask(task.id); })}>批准并继续</Button><Button size="sm" variant="outline" disabled={Boolean(action)} onClick={() => act("approval", async () => { await decideApproval(approval.id, "rejected"); await resumeTask(task.id); })}>拒绝</Button></div></div>)}
    {approvals.error && <p role="alert" className="text-xs text-destructive">审批加载失败：{errorMessage(approvals.error)}</p>}
    {reason === "budget_exceeded" && task.status === "paused" && <form className="space-y-2 rounded-lg border p-3" onSubmit={(e) => { e.preventDefault(); void act("resume", async () => { await resumeTask(task.id, { tokens, toolCalls: calls, wallMs: minutes * 60000, costUsd: task.budget?.costUsd ?? 0.5 }); }); }}><p className="text-xs font-medium">调整此任务总预算</p><Label htmlFor="task-token-budget">Token上限</Label><Input id="task-token-budget" type="number" min="1" max="4000000" value={tokens} onChange={(e) => setTokens(Number(e.target.value))} /><Label htmlFor="task-tool-budget">工具次数</Label><Input id="task-tool-budget" type="number" min="1" max="200" value={calls} onChange={(e) => setCalls(Number(e.target.value))} /><Label htmlFor="task-time-budget">执行时长（分钟）</Label><Input id="task-time-budget" type="number" min="1" max="60" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /><Button type="submit" size="sm" disabled={Boolean(action)}>调整预算并恢复</Button></form>}
    {resumeBlocked && <p className="text-xs leading-5 text-muted-foreground">后续对话已开始，请用新消息继续；原任务记录已保留。</p>}
    {["paused", "needs_input"].includes(task.status) && <p className="text-xs leading-5 text-muted-foreground">请先恢复、处理或取消此任务，再发送新消息；当前进度与记录会保留。</p>}
    {!local && <div className="flex flex-wrap gap-2">
      {!resumeBlocked && (["paused", "failed"].includes(task.status) || task.status === "needs_input" && !approvals.isPending && !pendingApprovals.length) && reason !== "budget_exceeded" && reason !== "missing_information" && reason !== "tool_protocol_error" && <Button size="sm" variant="outline" disabled={Boolean(action)} onClick={() => act("resume", async () => { await resumeTask(task.id); })}>恢复任务</Button>}
      {["queued", "running", "paused", "needs_input"].includes(task.status) && <Button size="sm" variant="ghost" disabled={Boolean(action) || task.cancelRequested} onClick={() => act("cancel", async () => { if (!await cancelTask(task.id)) throw new Error("此任务当前无法取消"); })}>取消任务</Button>}
      {task.status === "failed" && <Button size="sm" variant="ghost" onClick={() => onContinue(task.title)}>用新消息继续</Button>}
      {task.result?.partial && <Button size="sm" variant="outline" onClick={() => onContinue(`${task.title}（继续生成下一节）`)}>继续分节生成</Button>}
    </div>}
    {error && <p role="alert" className="whitespace-pre-wrap text-xs leading-5 text-destructive">{error}</p>}
  </>;
}

