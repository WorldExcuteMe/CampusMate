// Task Planner：Goal → 结构化 Plan（Step DAG）。单 Agent 调度，默认并发 1。
// Runtime 负责 Step 状态转换（模型不改 DB 状态）。每 Step 有非空验收条件，执行前冻结。
import { randomUUID } from "node:crypto";
import type { AcceptanceCriterion, StepStatus } from "./types.ts";
import { canStepTransition, assertStepTransition } from "../runtime/state-machine.ts";

export interface PlanStep {
  id: string;
  seq: number;
  kind: "plan" | "act" | "verify" | "summarize";
  title: string;
  input: string;
  expectedOutput: string;
  dependsOn: string[];
  acceptance: AcceptanceCriterion[];
  status: StepStatus;
}

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  version: number;
  acceptanceFrozen: boolean;
  createdAt: number;
}

export interface PlanDeviation { stepId: string; expected: string; actual: string; at: number; }

// 业务任务默认非空验收（解决"空验收退化为文本即完成"）。
export function defaultAcceptance(kind: "info" | "opportunity" | "plan" | "generic"): AcceptanceCriterion[] {
  switch (kind) {
    case "info": return [{ id: "src", kind: "source_cited", params: {}, required: true }, { id: "ev", kind: "evidence_verified", params: { min: 1 }, required: true }];
    case "opportunity": return [{ id: "src", kind: "source_cited", params: {}, required: true }, { id: "ev", kind: "evidence_verified", params: { min: 1 }, required: true }, { id: "deadline", kind: "field_present", params: { field: "deadline" }, required: false }];
    case "plan": return [{ id: "artifact", kind: "artifact_exists", params: { kind: "plan" }, required: true }, { id: "noexp", kind: "no_expired", params: {}, required: true }];
    default: return [{ id: "artifact", kind: "artifact_exists", params: {}, required: true }];
  }
}

// 确定性 Planner（第一版单 Agent）：按目标类型生成 3-4 步 DAG。LLM 可后续替换生成逻辑，但状态由 Runtime 管。
export function planGoal(goal: string, kind: "info" | "opportunity" | "plan" | "generic" = "generic"): Plan {
  const acc = defaultAcceptance(kind);
  const mk = (seq: number, k: PlanStep["kind"], title: string, input: string, expectedOutput: string, deps: string[], acceptance: AcceptanceCriterion[]): PlanStep =>
    ({ id: randomUUID(), seq, kind: k, title, input, expectedOutput, dependsOn: deps, acceptance, status: "pending" });
  const s1 = mk(1, "act", "收集信息", goal, "原始信息 + 来源", [], []);
  const s2 = mk(2, "verify", "核验来源", "原始信息", "已核验证据", [s1.id], acc);
  const s3 = mk(3, "summarize", "整合输出", "已核验证据", "结构化结果", [s2.id], defaultAcceptance("generic"));
  return { id: randomUUID(), goal, steps: [s1, s2, s3], version: 1, acceptanceFrozen: false, createdAt: Date.now() };
}

// 执行前冻结验收（变更需记录版本）。
export function freezeAcceptance(plan: Plan): Plan {
  return { ...plan, acceptanceFrozen: true };
}

// Plan Revision：升版本，保留旧验收版本记录。
export function revisePlan(plan: Plan, newSteps: PlanStep[]): Plan {
  return { ...plan, steps: newSteps, version: plan.version + 1, acceptanceFrozen: false };
}

// DAG 拓扑校验：无环、依赖存在。
export function validateDag(steps: PlanStep[]): { ok: boolean; reason?: string } {
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) for (const d of s.dependsOn) if (!ids.has(d)) return { ok: false, reason: `依赖不存在：${d}` };
  // 拓扑排序检测环
  const indeg = new Map(steps.map((s) => [s.id, s.dependsOn.length]));
  const queue = steps.filter((s) => s.dependsOn.length === 0).map((s) => s.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const s of steps) if (s.dependsOn.includes(id)) { const n = (indeg.get(s.id) ?? 1) - 1; indeg.set(s.id, n); if (n === 0) queue.push(s.id); }
  }
  return visited === steps.length ? { ok: true } : { ok: false, reason: "DAG 存在环" };
}

// 就绪 Step（依赖全 succeeded），默认并发 1 → 取 seq 最小的一个。
export function nextReadyStep(plan: Plan): PlanStep | null {
  const done = new Set(plan.steps.filter((s) => s.status === "succeeded").map((s) => s.id));
  const ready = plan.steps.filter((s) => s.status === "pending" && s.dependsOn.every((d) => done.has(d))).sort((a, b) => a.seq - b.seq);
  return ready[0] ?? null;
}

// Runtime 负责 Step 状态转换（模型不得直接改）。
export function transitionStep(plan: Plan, stepId: string, to: StepStatus): Plan {
  const steps = plan.steps.map((s) => {
    if (s.id !== stepId) return s;
    assertStepTransition(s.status, to);
    return { ...s, status: to };
  });
  return { ...plan, steps };
}

export { canStepTransition };