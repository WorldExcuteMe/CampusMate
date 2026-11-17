// 混合评测器：隐式运行时检查 + 声明式确定性检查 + 可选 LLM Judge。
// 事实边界：只读 EvalObservation，不写库；Judge 异常/非法返回降级为失败 CheckResult，
// 不向调用方抛出，保证单用例失败不会中断整轮评测。
import type { CheckResult, EvalCase, EvalObservation, EvalTurnObservation, FailureCategory, Judge } from "./types.ts";
import { classifyFailure, evaluateChecks, implicitRuntimeChecks } from "./checks.ts";

export interface EvaluateCaseResult {
  checks: CheckResult[];
  passed: boolean;
  failureCategory?: FailureCategory;
  failureReason?: string;
}

// 多轮用例的 turn 观测转成可复用 checks 的完整观测（case 不变，会话级字段沿用该轮）。
function turnAsObservation(caseDef: EvalCase, target: EvalObservation["target"], turn: EvalTurnObservation): EvalObservation {
  return {
    case: caseDef, target, status: turn.status, reply: turn.reply, toolCalls: turn.toolCalls,
    trace: turn.trace, business: turn.business, usage: turn.usage, durationMs: turn.durationMs,
    mock: turn.mock, ...(turn.error ? { error: turn.error } : {}),
  };
}

function prefixChecks(prefix: string, checks: CheckResult[]): CheckResult[] {
  return checks.map((check) => ({ ...check, id: `${prefix}-${check.id}`, label: `${prefix}·${check.label}` }));
}

export async function evaluateCase(c: EvalCase, obs: EvalObservation, judge?: Judge): Promise<EvaluateCaseResult> {
  const checks: CheckResult[] = [];
  // 多轮：逐轮检查（运行时 + 该轮声明 checks + expectedStatus），再做会话级检查。
  if (obs.turns?.length) {
    obs.turns.forEach((turn, index) => {
      const spec = c.turns?.[index];
      const turnObs = turnAsObservation(c, obs.target, turn);
      const prefix = `第${index + 1}轮`;
      checks.push(...prefixChecks(prefix, implicitRuntimeChecks(turnObs)));
      const declared = [...(spec?.checks ?? [])];
      if (spec?.expectedStatus !== undefined) {
        declared.push({ kind: "status", in: Array.isArray(spec.expectedStatus) ? spec.expectedStatus : [spec.expectedStatus] });
      }
      checks.push(...prefixChecks(prefix, evaluateChecks(declared, turnObs)));
    });
    if (c.turns && c.turns.length !== obs.turns.length) {
      checks.push({
        id: "turns_complete", kind: "runtime", label: "多轮执行完整", passed: false, required: true,
        detail: `用例声明 ${c.turns.length} 轮，实际执行 ${obs.turns.length} 轮（中途失败会保留已执行轮次）`,
      });
    }
  }
  // 顺序固定：隐式运行时检查在前，便于报告快速定位「运行时根本没跑完」。
  checks.push(...implicitRuntimeChecks(obs), ...evaluateChecks(c.checks, obs));
  if (judge) checks.push(await runJudge(c, obs, judge));
  const passed = checks.every((check) => !check.required || check.passed);
  const result: EvaluateCaseResult = { checks, passed };
  if (!passed) {
    const failure = classifyFailure(checks, obs);
    if (failure) {
      result.failureCategory = failure.category;
      result.failureReason = failure.reason;
    }
  }
  return result;
}

// Judge 结果统一成 CheckResult：required 由 case.judge.minScore 是否存在决定；
// 有 minScore 时以分数门槛为准（verdict.passed 仅作说明），无 minScore 时看 verdict.passed。
async function runJudge(c: EvalCase, obs: EvalObservation, judge: Judge): Promise<CheckResult> {
  const minScore = c.judge?.minScore;
  const required = minScore !== undefined;
  const label = minScore !== undefined ? `Judge 评分 ≥${minScore}` : "Judge 评分";
  const base = { id: "judge", kind: "judge" as const, label, required };
  try {
    const verdict = await judge.evaluate(c, obs);
    if (!verdict || typeof verdict !== "object" || typeof verdict.score !== "number" || !Number.isFinite(verdict.score)) {
      return { ...base, passed: false, detail: `Judge ${judge.name} 返回非法结果（缺少有限 score）：${clipValue(verdict)}` };
    }
    const score = verdict.score;
    const passed = minScore === undefined ? verdict.passed === true : score >= minScore;
    const dims = verdict.dimensions && Object.keys(verdict.dimensions).length ? `；维度 ${clipValue(verdict.dimensions)}` : "";
    return {
      ...base,
      passed,
      detail: `Judge ${judge.name} 评分 ${score}/100（门槛 ${minScore ?? "无"}，判定 ${verdict.passed === true ? "通过" : "未通过"}）：${clipText(verdict.reason)}${dims}`,
    };
  } catch (err) {
    return { ...base, passed: false, detail: `Judge ${judge.name} 执行失败：${errorMessage(err)}` };
  }
}

function clipText(text: unknown, max = 240): string {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!one) return "（无 reason）";
  return one.length <= max ? one : `${one.slice(0, max)}…（共 ${one.length} 字符）`;
}

function clipValue(value: unknown): string {
  try { return clipText(JSON.stringify(value)); } catch { return clipText(String(value)); }
}

// 兜底错误消息：Error/字符串/普通对象都可读，不产出 [object Object]。
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err) ?? String(err); } catch { return String(err); }
}
