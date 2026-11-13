import type { ToolDef } from "../llm/proxy";

export const AGENT_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "extract_notice",
      description: "从用户粘贴的校园通知/群消息文本中提取结构化信息（标题/类别/截止/条件等）。",
      parameters: {
        type: "object",
        properties: { rawText: { type: "string", description: "通知原文" } },
        required: ["rawText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_daily_task",
      description: "把日常事务（调课/班会/讲座等含时间日期的信息）创建为日常任务。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          dueAt: { type: "string", description: "YYYY-MM-DD 或 null" },
          timeText: { type: "string", description: "原文时间描述，如「周五 19:00」" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_opportunities",
      description: "按关键词与类别检索竞赛/实习/科研等机会（来源为官方白名单与公开渠道）。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          category: { type: "string", description: "competition/internship/research/scholarship/activity/opensource" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "match_opportunities",
      description: "结合用户画像对机会做个性化匹配并给出理由。",
      parameters: { type: "object", properties: { limit: { type: "number" } } },
    },
  },
];