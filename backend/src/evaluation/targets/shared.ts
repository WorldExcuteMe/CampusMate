// Target 共享工具：用例身份、上下文注入、业务事实快照。
// 事实来源：Worker 会把 personalContext.profile 注入 system 层；课表/固定时钟不由 Worker 自动注入，
// 因此评测通道显式追加到 system 文本，保证 live 与 scripted 看到同一份「用户处境」。
import type { AppContext } from "../../app-context.ts";
import { CAMPUS_SYSTEM } from "../../core/system-prompt.ts";
import { sha256 } from "../dataset.ts";
import type { BusinessSnapshot, EvalCase } from "../types.ts";
import { blockText, bodyChars, type DocumentAst } from "../../../../shared/document.ts";
import { inspectExport, type DocumentFormat } from "../../core/document-renderer.ts";

const WEEKDAY = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// 每个用例独立 owner id：隔离数据，且重复运行时身份稳定（便于对账/清理）。
export function userIdForCase(caseId: string): string {
  const hash = sha256(`campusmate-eval:${caseId}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function safeCaseId(caseId: string): string {
  return caseId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

export function caseSystemPrompt(c: EvalCase): string {
  const parts = [CAMPUS_SYSTEM];
  const context = c.context;
  if (!context) return parts.join("\n\n");
  if (context.now) parts.push(`【评测固定时钟】本次任务的“当前时间”以 ${context.now}（Asia/Shanghai）为准。`);
  if (context.profile) parts.push(`【评测用户身份】${JSON.stringify(context.profile)}`);
  if (context.term) parts.push(`【评测学期】${context.term.name ?? "评测学期"}：${context.term.startDate} 至 ${context.term.endDate}，共 ${context.term.totalWeeks ?? 20} 教学周。`);
  if (context.schedules?.length) {
    const lines = context.schedules.map((s) => `${WEEKDAY[s.weekday] ?? `周${s.weekday}`} ${s.startTime}-${s.endTime} ${s.courseName}${s.classroom ? `（${s.classroom}）` : ""}${s.weekPattern === "odd" ? " [单周]" : s.weekPattern === "even" ? " [双周]" : ""} 第${s.startWeek}-${s.endWeek}周`);
    parts.push(`【评测用户课表】\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

// 播种用户上下文：个人画像 / 学期 / 课表。同一 target 内按 userId 隔离。
export async function seedCaseContext(ctx: AppContext, c: EvalCase, userId: string): Promise<void> {
  const context = c.context;
  if (!context) return;
  const profile = context.profile;
  if (profile) {
    await ctx.personalContext.setProfile({
      university: "评测示例大学", major: "计算机科学与技术", grade: "大二", interests: [], skills: [], goals: [], preferences: {},
      ...profile, updatedAt: Date.now(), userId,
    });
  }
  const term = context.term;
  if (term) {
    const created = await ctx.personalContext.createTerm({
      userId, institutionId: term.institutionId ?? "eval-school", name: term.name ?? "评测学期",
      startDate: term.startDate, endDate: term.endDate, totalWeeks: term.totalWeeks ?? 20, timezone: term.timezone ?? "Asia/Shanghai",
    });
    if (context.schedules?.length) await ctx.personalContext.saveSchedules(userId, created.id, context.schedules);
  }
}

// 业务事实快照：只读，供确定性检查核对副作用；任何存储失败都降级为空，不影响评测主流程。
export async function businessSnapshot(ctx: AppContext, userId: string, taskId: string): Promise<BusinessSnapshot> {
  const snapshot: BusinessSnapshot = { inbox: [], opportunities: [], pendingApprovals: 0, artifacts: [], evidenceVerified: 0 };
  try {
    snapshot.inbox = (await ctx.campusRecords.listInbox(userId)).map((item) => ({
      id: item.id, title: String((item.extracted as Record<string, unknown>).title ?? ""),
      deadline: ((item.extracted as Record<string, unknown>).deadline as string | null | undefined) ?? null,
    }));
  } catch { /* 存储不可用按空处理 */ }
  try {
    snapshot.opportunities = (await ctx.opportunityStore.listByUser(userId)).map((item) => ({ id: item.id, title: item.title, deadline: item.deadline ?? null, sourceUrl: item.sourceUrl ?? null }));
  } catch { /* ignore */ }
  try { snapshot.pendingApprovals = (await ctx.approvals.listPendingByUser(userId)).length; } catch { /* ignore */ }
  try {
    const artifacts = await ctx.artifactStore.listByTask(userId, taskId);
    snapshot.artifacts = artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, title: (artifact.inline as { title?: string } | undefined)?.title }));
    for (const artifact of artifacts.filter(item => item.kind === "document-export")) {
      const entry = snapshot.artifacts.find(item => item.id === artifact.id)!;
      try {
        const file = ctx.documents.file(artifact);
        const source = await ctx.artifactStore.get(userId, file.sourceArtifactId);
        if (!source || source.kind !== "document") continue;
        const ast = source.inline as DocumentAst;
        const format = (artifact.inline as { format: DocumentFormat }).format;
        const inspected = await inspectExport(ast, file.bytes, format);
        Object.assign(entry, { title: ast.title, format, bytes: file.bytes.length, inspectionPassed: inspected.passed, sourceArtifactId: source.id, text: ast.title + "\n" + ast.blocks.map(blockText).join("\n"), headings: ast.blocks.filter(block => block.type === "heading").length, bodyChars: bodyChars(ast) });
      } catch { entry.inspectionPassed = false; }
    }
  } catch { /* ignore */ }
  try { snapshot.evidenceVerified = (await ctx.evidenceStore.listByTask(taskId)).filter((e) => e.verified).length; } catch { /* ignore */ }
  return snapshot;
}
