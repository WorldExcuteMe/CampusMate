// 三开发者 Dogfooding 记录 + 统一失败案例库。成功适配 → 回归测试。
// 不得将三人结果宣称为全国高校泛化。

export interface DogfoodingRecord {
  taskId: string;
  developer: string;            // 开发者标识（脱敏）
  userGoal: string;
  institution: string;          // 学校
  environment: string;          // 系统/网站
  dataSource: string;           // 信息来源
  dataFormat: string;           // 数据格式
  acquisitionMethod: string;    // 获取方法
  agentPlan: string[];          // Agent 执行计划
  executionTrace: string[];     // 执行轨迹
  humanIntervention: number;    // 人工介入次数
  failureReason?: string;
  finalResult: "success" | "partial" | "failed";
  resultAccuracy?: number;      // 结果准确率
  reusableAdaptation?: string;  // 可复用适配能力
}

export interface FailureCase {
  id: string;
  taskId: string;
  category: string;
  symptom: string;
  rootCause: string;
  reproduction: string;
  regressionTestId?: string;    // 修复后必须形成回归测试
  status: "open" | "fixed" | "regression_added";
}

export class FailureLibrary {
  private cases = new Map<string, FailureCase>();
  add(c: FailureCase): void { this.cases.set(c.id, c); }
  get(id: string): FailureCase | null { return this.cases.get(id) ?? null; }
  list(): FailureCase[] { return [...this.cases.values()]; }
  open(): FailureCase[] { return this.list().filter((c) => c.status === "open"); }
  // 成功适配 → 回归（标记）。
  markRegression(id: string, regressionTestId: string): void {
    const c = this.cases.get(id);
    if (c) this.cases.set(id, { ...c, status: "regression_added", regressionTestId });
  }
}

// 核心挑战（三开发者相同目标，不同获取方式）。
export const CORE_CHALLENGE = "获取个人课表，识别学期时间安排，并结合校园通知、竞赛和个人目标生成未来七天行动计划。";

// 记录模板（开发者填写）。
export function emptyRecord(developer: string, institution: string): DogfoodingRecord {
  return { taskId: "", developer, userGoal: CORE_CHALLENGE, institution, environment: "", dataSource: "", dataFormat: "", acquisitionMethod: "", agentPlan: [], executionTrace: [], humanIntervention: 0, finalResult: "failed" };
}