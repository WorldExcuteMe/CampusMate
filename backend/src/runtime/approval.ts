// 服务端强制审批（非仅 Prompt）。高危工具调用前必须有 approved 记录，否则不执行。
// 审批状态机：pending → approved | rejected（终态）。owner 隔离。
import { randomUUID } from "node:crypto";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Approval {
  id: string;
  taskId: string;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
  risk: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt?: number;
}

export interface ApprovalStore {
  create(input: { taskId: string; userId: string; toolName: string; args: Record<string, unknown>; idempotencyKey: string; risk: string }): Promise<Approval>;
  get(id: string): Promise<Approval | null>;
  findByKey(taskId: string, idempotencyKey: string): Promise<Approval | null>;
  decide(id: string, userId: string, decision: "approved" | "rejected"): Promise<Approval | null>;
  listPendingByUser(userId: string): Promise<Approval[]>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private items = new Map<string, Approval>();

  async create(input: { taskId: string; userId: string; toolName: string; args: Record<string, unknown>; idempotencyKey: string; risk: string }): Promise<Approval> {
    // 同 (task, idempotencyKey) 已有审批则复用（避免重复弹窗）。
    const existing = await this.findByKey(input.taskId, input.idempotencyKey);
    if (existing) return existing;
    const a: Approval = { id: randomUUID(), ...input, status: "pending", createdAt: Date.now() };
    this.items.set(a.id, a);
    return a;
  }
  async get(id: string): Promise<Approval | null> { return this.items.get(id) ?? null; }
  async findByKey(taskId: string, idempotencyKey: string): Promise<Approval | null> {
    return [...this.items.values()].find((a) => a.taskId === taskId && a.idempotencyKey === idempotencyKey) ?? null;
  }
  async decide(id: string, userId: string, decision: "approved" | "rejected"): Promise<Approval | null> {
    const a = this.items.get(id);
    if (!a || a.userId !== userId) return null; // owner 隔离
    if (a.status !== "pending") return a; // 终态不可改
    const next: Approval = { ...a, status: decision, decidedAt: Date.now() };
    this.items.set(id, next);
    return next;
  }
  async listPendingByUser(userId: string): Promise<Approval[]> {
    return [...this.items.values()].filter((a) => a.userId === userId && a.status === "pending").sort((x, y) => x.createdAt - y.createdAt);
  }
}

// 高危工具判定：本机执行/文件写/全局写/核验升级 需审批。云端只读工具不需要。
export function requiresApproval(toolName: string, _args: Record<string, unknown>): { required: boolean; risk: string } {
  switch (toolName) {
    case "run_terminal": return { required: true, risk: "在用户主机执行终端命令" };
    case "write_file": return { required: true, risk: "写入用户主机文件" };
    case "read_file": return { required: true, risk: "读取用户主机文件" };
    case "create_opportunity": return { required: true, risk: "写入全局机会数据" };
    case "propose_verification": return { required: true, risk: "升级核验状态（需证据）" };
    case "sync_group_notices": return { required: true, risk: "访问本机 QQ/微信数据" };
    default: return { required: false, risk: "" };
  }
}