// 轻量可观测：任务/Worker/工具/失败指标，按 task_id→step_id→tool_invocation_id→event_id 关联。
// 内存聚合（生产可导出到日志/指标系统）。不引入大型基础设施。

export interface TraceRef { taskId: string; stepId?: string; toolInvocationId?: string; eventId?: number; }

export interface MetricsSnapshot {
  taskSuccess: number; taskFailure: number; taskSuccessRate: number;
  toolCalls: number; toolFailures: number; toolFailureRate: number;
  evaluatorRejections: number; evaluatorRejectionRate: number;
  tokens: number; costUsd: number;
  taskDurationsMs: number[]; avgTaskDurationMs: number;
  queueDepth: number; leaseExpirations: number; workerHeartbeats: number;
}

export class MetricsCollector {
  private taskSuccess = 0;
  private taskFailure = 0;
  private toolCalls = 0;
  private toolFailures = 0;
  private evalTotal = 0;
  private evalRejections = 0;
  private tokens = 0;
  private costUsd = 0;
  private durations: number[] = [];
  private queueDepth = 0;
  private leaseExpirations = 0;
  private heartbeats = 0;
  private traces: TraceRef[] = [];

  // 关联链记录（审计/排障）。
  trace(ref: TraceRef): void { this.traces.push(ref); }
  getTraces(taskId: string): TraceRef[] { return this.traces.filter((t) => t.taskId === taskId); }

  taskSucceeded(durationMs: number, tokens: number, costUsd: number): void { this.taskSuccess++; this.durations.push(durationMs); this.tokens += tokens; this.costUsd += costUsd; }
  taskFailed(): void { this.taskFailure++; }
  toolCalled(failed: boolean): void { this.toolCalls++; if (failed) this.toolFailures++; }
  evaluated(passed: boolean): void { this.evalTotal++; if (!passed) this.evalRejections++; }
  setQueueDepth(n: number): void { this.queueDepth = n; }
  leaseExpired(): void { this.leaseExpirations++; }
  heartbeat(): void { this.heartbeats++; }

  snapshot(): MetricsSnapshot {
    const tasks = this.taskSuccess + this.taskFailure;
    const avg = this.durations.length ? this.durations.reduce((a, b) => a + b, 0) / this.durations.length : 0;
    return {
      taskSuccess: this.taskSuccess, taskFailure: this.taskFailure, taskSuccessRate: tasks ? this.taskSuccess / tasks : 0,
      toolCalls: this.toolCalls, toolFailures: this.toolFailures, toolFailureRate: this.toolCalls ? this.toolFailures / this.toolCalls : 0,
      evaluatorRejections: this.evalRejections, evaluatorRejectionRate: this.evalTotal ? this.evalRejections / this.evalTotal : 0,
      tokens: this.tokens, costUsd: this.costUsd,
      taskDurationsMs: [...this.durations], avgTaskDurationMs: avg,
      queueDepth: this.queueDepth, leaseExpirations: this.leaseExpirations, workerHeartbeats: this.heartbeats,
    };
  }
}