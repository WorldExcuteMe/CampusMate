// 工具幂等键：自然键优先，回退 canonical args hash。配合 store.recordInvocation 唯一约束防重复副作用。
import { createHash } from "node:crypto";

export function canonicalArgs(args: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object"
      ? Object.keys(v as object).sort().reduce((o, k) => { o[k] = sort((v as Record<string, unknown>)[k]); return o; }, {} as Record<string, unknown>)
      : v;
  return JSON.stringify(sort(args));
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function normTitle(t: string): string {
  return (t ?? "").replace(/\s+/g, "").replace(/[，,。.！!？?：:；;、]/g, "").toLowerCase();
}

export interface IdemCtx { userId: string; }

export function idempotencyKey(tool: string, args: Record<string, unknown>, ctx: IdemCtx): string {
  switch (tool) {
    case "save_to_inbox":
    case "extract_notice": {
      const title = normTitle(String(args.title ?? args.rawText ?? ""));
      const deadline = String(args.deadline ?? "");
      const source = String(args.source ?? args.sourceUrl ?? "");
      return `inbox:${ctx.userId}:${sha256(`${title}|${deadline}|${source}`)}`;
    }
    case "create_opportunity": {
      const h = sha256(`${normTitle(String(args.title ?? ""))}|${args.type ?? ""}|${args.deadline ?? ""}|${args.sourceUrl ?? ""}`);
      return `opp:${h}`;
    }
    case "create_daily_task": {
      return `daily:${ctx.userId}:${sha256(`${normTitle(String(args.title ?? ""))}|${args.dueAt ?? args.timeText ?? ""}`)}`;
    }
    case "set_growth_goal": {
      return `goal:${ctx.userId}:${normTitle(String(args.goal ?? ""))}`;
    }
    default:
      return `${tool}:${sha256(canonicalArgs(args))}`;
  }
}