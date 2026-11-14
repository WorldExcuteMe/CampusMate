// 长任务记忆与计划（参考 DSH goal/plan 状态机 + session 记忆 checkpoint）。
// 计划与滚动摘要持久化到 localStorage，跨轮注入 system prompt，保证连续长任务不丢记忆；
// 摘要只记录已核实事实与来源，抑制幻觉累积。
export interface Plan {
  goal: string;
  steps: string[];
  done: number[];
  createdAt: string;
}
const PLAN_KEY = "campusmate.plan.v1";
const MEM_KEY = "campusmate.memory.v1";

export function getPlan(): Plan | null {
  try {
    return JSON.parse(localStorage.getItem(PLAN_KEY) || "null");
  } catch {
    return null;
  }
}
export function setPlan(p: Plan): void {
  // best-effort：localStorage 配额满/不可用时静默跳过，绝不因记忆写入失败中断模型回合。
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify(p));
  } catch {
    /* quota / unavailable */
  }
}
export function advancePlan(stepIndex: number): void {
  const p = getPlan();
  if (p && !p.done.includes(stepIndex)) {
    p.done.push(stepIndex);
    setPlan(p);
  }
}
export function clearPlan(): void {
  localStorage.removeItem(PLAN_KEY);
}

// 滚动记忆：每轮结束追加一条「已核实事实+来源」摘要，上限保留最近 N 条。
export function getMemory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(MEM_KEY) || "[]");
  } catch {
    return [];
  }
}
export function appendMemory(entry: string): void {
  // best-effort：记忆是缓存而非关键路径，写入失败不得把已成功的模型答复误降级为中断。
  try {
    const mem = getMemory();
    mem.push(entry);
    localStorage.setItem(MEM_KEY, JSON.stringify(mem.slice(-12)));
  } catch {
    /* quota / unavailable */
  }
}
export function clearMemory(): void {
  localStorage.removeItem(MEM_KEY);
}

export function memoryPrompt(): string {
  const plan = getPlan();
  const mem = getMemory();
  const parts: string[] = [];
  if (plan) {
    const steps = plan.steps.map((s, i) => `${plan.done.includes(i) ? "[x]" : "[ ]"} ${i + 1}. ${s}`).join("\n");
    parts.push(`【长任务计划】目标：${plan.goal}\n${steps}\n按未完成步骤继续执行，完成后更新；不要重复已完成步骤。`);
  }
  if (mem.length) {
    parts.push(`【会话记忆（已核实事实+来源，勿编造）】\n${mem.join("\n")}`);
  }
  return parts.join("\n");
}