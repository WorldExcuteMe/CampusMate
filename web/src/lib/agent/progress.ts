// Observable execution stages only. A pending HTTP request does not prove that
// the model is reasoning; never fabricate a thought stream or percentage.
export interface AgentProgress {
  phase: "preparing" | "environment" | "bootstrap" | "model" | "tool" | "summary" | "queued" | "running" | "evaluating" | "saving" | "approval";
  tool?: string;
  round?: number;
  toolIndex?: number;
  toolTotal?: number;
  completedTools?: number;
}
export interface AgentActivity {
  sessionId: string;
  startedAt: number;
  stageAt: number;
  progress: AgentProgress;
}
const TOOL_LABELS: Record<string, string> = {
  extract_notice: "解析通知", create_daily_task: "创建待办", search_opportunities: "查询机会",
  match_opportunities: "匹配机会", sync_group_notices: "读取群通知", list_groups: "发现本机群聊",
  run_terminal: "执行本地命令", read_file: "读取文件", write_file: "写入文件",
  web_fetch: "读取网页", rag_search: "检索本地资料", merge_inbox: "整理重复通知",
  save_to_inbox: "保存通知", create_opportunity: "保存机会", save_opportunity: "保存机会",
  list_opportunities: "查询已存机会", verify_opportunity: "核验机会", propose_verification: "提交核验",
  set_growth_goal: "更新成长目标", web_search: "检索公开信息", create_plan: "制定计划",
};
export function progressText(progress: AgentProgress): { label: string; title: string; detail: string } {
  switch (progress.phase) {
    case "preparing": return { label: "准备", title: "正在准备请求", detail: "整理当前消息和会话上下文。" };
    case "environment": return { label: "环境", title: "正在检查本地环境", detail: "等待本地服务返回 QQ / 微信读取能力状态。" };
    case "bootstrap": return { label: "环境", title: "正在准备通知读取环境", detail: "等待本地配置工具返回结果。" };
    case "model": return { label: "模型", title: "正在等待模型回复", detail: progress.completedTools ? `已返回 ${progress.completedTools} 次工具结果，等待模型决定下一步。` : "请求已发出，等待模型服务返回。" };
    case "tool": return { label: "工具", title: `正在${TOOL_LABELS[progress.tool ?? ""] ?? "执行工具"}`, detail: progress.toolTotal ? `当前批次第 ${progress.toolIndex ?? 1} / ${progress.toolTotal} 个工具，等待实际执行结果。` : "等待工具返回实际执行结果。" };
    case "summary": return { label: "整理", title: "正在等待模型整理结果", detail: "已发送无工具总结请求，等待最终回复。" };
    case "queued": return { label: "后台", title: "后台任务排队中", detail: "任务已提交，等待 Worker 接手。" };
    case "running": return { label: "后台", title: "后台任务运行中", detail: "等待后台返回具体执行阶段。" };
    case "evaluating": return { label: "核验", title: "正在核验执行结果", detail: "等待后台完成验收，不以模型自报完成为准。" };
    case "saving": return { label: "保存", title: "正在保存执行进度", detail: "等待后台确认检查点写入。" };
    case "approval": return { label: "审批", title: "任务正在等待审批", detail: "待批准操作尚未执行。" };
  }
}
export function progressFromEvent(event: { type: string; payload: Record<string, unknown> }): AgentProgress | null {
  const round = typeof event.payload.round === "number" ? event.payload.round + 1 : undefined;
  switch (event.type) {
    case "task.queued": return { phase: "queued" };
    case "task.claimed": return { phase: "running" };
    case "llm.request": return { phase: "model", round };
    case "tool.called": return { phase: "tool", tool: typeof event.payload.name === "string" ? event.payload.name : undefined };
    case "tool.result": return { phase: "running" };
    case "checkpoint.written": return { phase: "running" };
    case "tool.approval_requested": case "task.needs_input": return { phase: "approval" };
    default: return null;
  }
}
