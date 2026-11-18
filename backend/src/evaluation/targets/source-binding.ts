import { validateSourceGrants, type SourceGrant } from "../../runtime/linked-sources.ts";
import { validateTerm } from "../../../../shared/calendar.ts";
import type { EvalUserContext } from "../types.ts";

export interface SourceReference {
  grants: SourceGrant[];
  hash: string;
  minPages: number;
  sourceId?: string;
  scheduleDigest?: string;
  term?: EvalUserContext["term"];
  served?: () => number;
}

export function parseSourceBindings(value: unknown, caseIds: ReadonlySet<string>): Map<string, SourceReference> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("评测授权配置应为用例 ID 到数据源与参照摘要的映射");
  const bindings = new Map<string, SourceReference>();
  const isDigest = (digest: unknown): digest is string => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest);
  for (const [id, raw] of Object.entries(value)) {
    if (!caseIds.has(id) || !raw || typeof raw !== "object") throw new Error("评测授权配置包含未选定或无法绑定的用例");
    const spec = raw as Record<string, unknown>;
    const grants = validateSourceGrants(spec.grants);
    const minPages = spec.minPages ?? 1;
    const sourceId = spec.sourceId;
    if (!grants.length || typeof sourceId !== "string" || !grants.some(grant => grant.id === sourceId) || !isDigest(spec.sha256) ||
        typeof minPages !== "number" || !Number.isSafeInteger(minPages) || minPages < 1 || minPages > 32 ||
        (spec.scheduleDigest !== undefined && !isDigest(spec.scheduleDigest))) throw new Error("评测授权配置缺少合法的来源 ID、独立摘要或页数阈值");
    let term: EvalUserContext["term"];
    if (spec.term !== undefined) {
      if (!spec.term || typeof spec.term !== "object" || Array.isArray(spec.term)) throw new Error("评测账户学期配置无效");
      const rawTerm = spec.term as NonNullable<EvalUserContext["term"]>;
      if (typeof rawTerm.name !== "string" || !rawTerm.name.trim() || rawTerm.name.length > 100 ||
          typeof rawTerm.startDate !== "string" || typeof rawTerm.endDate !== "string" ||
          typeof rawTerm.totalWeeks !== "number" || typeof rawTerm.timezone !== "string") throw new Error("评测账户学期配置无效");
      validateTerm({ startDate: rawTerm.startDate, endDate: rawTerm.endDate, totalWeeks: rawTerm.totalWeeks, timezone: rawTerm.timezone });
      term = { name: rawTerm.name, startDate: rawTerm.startDate, endDate: rawTerm.endDate, totalWeeks: rawTerm.totalWeeks, timezone: rawTerm.timezone };
    }
    if (spec.scheduleDigest && !term) throw new Error("真实课表评测需提供账户的学期元数据");
    bindings.set(id, { grants, hash: spec.sha256, minPages, sourceId, scheduleDigest: spec.scheduleDigest as string | undefined, term });
  }
  return bindings;
}
