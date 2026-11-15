// 独立 Evaluator：不复用 Executor 的自我声明，按验收条件逐条核验。
// evidence_verified 独立重抓 URL 比对 excerpt（防幻觉证据）；全部 required 通过才签发 passed。
import type { AcceptanceCriterion, CompletionCertificate } from "./types.ts";
import { evaluateCriterion, type Evidence, type EvidenceStore, type EvaluationInput, type CriterionOutcome } from "./evidence.ts";
import { safeFetch, htmlToText } from "./ssrf.ts";
import { errorMessage } from "./errors.ts";

export type FetchFn = (url: string) => Promise<{ status: number; text: string }>;

const defaultFetch: FetchFn = async (url) => {
  const r = await safeFetch(url);
  return { status: r.status, text: htmlToText(r.text) };
};

// 规范化文本用于 excerpt 比对（去空白/标点/大小写）。
function norm(s: string): string {
  return (s ?? "").replace(/\s+/g, "").replace(/[，,。.！!？?：:；;、（）()【】\[\]"'“”]/g, "").toLowerCase();
}

export interface EvaluatorDeps {
  evidenceStore: EvidenceStore;
  fetchImpl?: FetchFn;
  now?: () => number;
}

export class Evaluator {
  private evidenceStore: EvidenceStore;
  private fetchImpl: FetchFn;
  private now: () => number;
  constructor(deps: EvaluatorDeps) {
    this.evidenceStore = deps.evidenceStore;
    this.fetchImpl = deps.fetchImpl ?? defaultFetch;
    this.now = deps.now ?? Date.now;
  }

  // 独立重抓核验单条证据：URL 可达 + excerpt 出现在抓取正文中。
  async verifyEvidence(e: Evidence): Promise<{ verified: boolean; note: string }> {
    if (!e.sourceUrl || !/^https?:/.test(e.sourceUrl)) return { verified: false, note: "证据来源非公开 http(s) URL" };
    if (!e.excerpt || norm(e.excerpt).length < 4) return { verified: false, note: "证据 excerpt 过短/缺失" };
    try {
      const r = await this.fetchImpl(e.sourceUrl);
      if (r.status < 200 || r.status >= 300) return { verified: false, note: `重抓 HTTP ${r.status}` };
      const body = norm(r.text);
      const needle = norm(e.excerpt);
      // excerpt 须为抓取正文子串（允许截断：取前 60 字符比对）。
      const probe = needle.slice(0, 60);
      if (!body.includes(probe)) return { verified: false, note: "excerpt 与抓取正文不符（疑似幻觉）" };
      return { verified: true, note: "独立重抓比对一致" };
    } catch (err) {
      return { verified: false, note: `重抓失败：${errorMessage(err)}` };
    }
  }

  async evaluate(taskId: string, criteria: AcceptanceCriterion[], input: EvaluationInput): Promise<CompletionCertificate> {
    const outcomes: CriterionOutcome[] = [];
    for (const c of criteria) {
      if (c.kind === "evidence_verified") {
        const min = Number(c.params?.min ?? 1);
        const candidates = input.evidence;
        const verifiedIds: string[] = [];
        const notes: string[] = [];
        for (const e of candidates) {
          const r = await this.verifyEvidence(e);
          await this.evidenceStore.markVerified(e.id, r.verified);
          if (r.verified) verifiedIds.push(e.id);
          else notes.push(`${e.sourceUrl}: ${r.note}`);
        }
        const passed = verifiedIds.length >= min;
        outcomes.push({ id: c.id, passed, evidenceIds: verifiedIds, note: passed ? `${verifiedIds.length} 条证据独立核验通过` : `核验通过不足（需≥${min}）：${notes.join("；") || "无证据"}` });
      } else {
        outcomes.push(evaluateCriterion(c, input));
      }
    }
    const required = criteria.filter((c) => c.required);
    const passed = required.every((c) => outcomes.find((o) => o.id === c.id)?.passed === true);
    return { taskId, evaluatedBy: "evaluator", passed, criteria: outcomes, evaluatedAt: this.now() };
  }
}

// 从任务结果构建验收输入（产物/字段/计数/来源由调用方按业务填充）。
export function buildEvaluationInput(partial: Partial<EvaluationInput> & { reply: string }): EvaluationInput {
  return {
    artifacts: partial.artifacts ?? [],
    evidence: partial.evidence ?? [],
    fields: partial.fields ?? {},
    counts: partial.counts ?? {},
    expiredCount: partial.expiredCount ?? 0,
    citedSources: partial.citedSources ?? [],
    reply: partial.reply,
  };
}