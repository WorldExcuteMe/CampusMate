// Task / Step 状态机（纯函数，强制转换规则）。事实来源的结构化状态转换校验。
import type { TaskStatus, StepStatus } from "../core/types.ts";

export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["needs_input", "paused", "succeeded", "failed", "cancelled", "queued"],
  needs_input: ["running", "paused", "cancelled", "queued"],
  paused: ["running", "cancelled", "queued"],
  succeeded: [],
  failed: ["queued"],
  cancelled: [],
};

export const STEP_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  pending: ["ready", "skipped"],
  ready: ["running", "skipped"],
  running: ["succeeded", "failed", "skipped"],
  succeeded: [],
  failed: ["ready", "skipped"],
  skipped: [],
};

export function canTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTaskTransition(from, to)) throw new Error(`非法任务状态转换：${from} → ${to}`);
}

export function canStepTransition(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!canStepTransition(from, to)) throw new Error(`非法步骤状态转换：${from} → ${to}`);
}

// succeeded 仅当 Evaluator 通过（执行 Agent 不得自判）。
export function canMarkSucceeded(certificatePassed: boolean): boolean {
  return certificatePassed === true;
}