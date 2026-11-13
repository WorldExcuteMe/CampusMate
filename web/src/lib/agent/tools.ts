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
  {
    type: "function",
    function: {
      name: "sync_group_notices",
      description: "从本地 QQ/微信群（信息本位：日期/关键词/文件，不限发送人）摄取通知并同步到 Inbox/日常任务/机会雷达。group 可为群名或群号；省略时自动定位通知群。",
      parameters: {
        type: "object",
        properties: { group: { type: "string", description: "群名称或群号（可选，省略自动定位）" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_groups",
      description: "列出本机 QQ 全部群（群号+消息数+样例），用于普适地定位任意用户的通知群，不硬编码群名。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_terminal",
      description: "在用户主机执行终端命令（完全访问，用户授权），用于运行脚本/查询环境/执行抓取。",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, cwd: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取用户主机本地文件内容。",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "写入用户主机本地文件。",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "抓取指定真实 URL 的网页正文（不替换代理地址），用于核实来源/获取公开信息。",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "rag_search",
      description: "在已摄取的群通知/本地文档中检索相关片段（RAG）。group 指定时仅检索该群（源内检索，避免群外噪音）。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          k: { type: "number" },
          group: { type: "string", description: "群号/群名（可选；锁定信息源时由系统强制指定）" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "merge_inbox",
      description: "对 Inbox（含历史通知）做语义去重合并：本质指向同一信息源/同一事件的通知归一展示，重复条归档，减少冗余。不同轮次不合并。注意：本工具只去重不新建；新建条目用 save_to_inbox / create_daily_task。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "save_to_inbox",
      description: "把一条归纳后的有效通知写入 Inbox（新建条目）。总结群通知后须用本工具落库，每条独立通知一次调用。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "通知标题" },
          summary: { type: "string", description: "归纳摘要（时间/地点/对象/要求）" },
          category: { type: "string", description: "competition/internship/research/scholarship/activity/opensource/notice/daily" },
          deadline: { type: "string", description: "YYYY-MM-DD 或 null" },
          source: { type: "string", description: "来源（群号/消息时间/链接）" },
        },
        required: ["title", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_opportunity",
      description: "把一条竞赛/实习/科研/奖助等机会写入机会雷达（新建条目）。来源须真实（官方链接/群消息），不得编造。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          type: { type: "string", description: "competition/internship/research/scholarship/activity/opensource" },
          organizer: { type: "string" },
          description: { type: "string" },
          deadline: { type: "string", description: "YYYY-MM-DD 或 null" },
          sourceUrl: { type: "string", description: "真实来源链接" },
        },
        required: ["title", "type", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_opportunity",
      description: "对机会做可信核验并写入可信核验报告：交叉核对官方来源/截止时间/收费风险，给出 VERIFIED/PARTIALLY_VERIFIED/UNVERIFIED/CONFLICTING/RISK_FLAGGED 与证据。",
      parameters: {
        type: "object",
        properties: {
          opportunityId: { type: "string" },
          status: { type: "string", description: "VERIFIED/PARTIALLY_VERIFIED/UNVERIFIED/CONFLICTING/RISK_FLAGGED" },
          summary: { type: "string" },
          evidence: { type: "array", items: { type: "object", properties: { sourceUrl: { type: "string" }, excerpt: { type: "string" }, supports: { type: "string" }, confidence: { type: "number" } } } },
        },
        required: ["opportunityId", "status", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_growth_goal",
      description: "设定/更新成长目标（写入个人画像 goals）并创建一条跟踪任务到成长中心。用于把机会转化为行动目标。",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "成长目标，如「11月底前完成华为ICT创新赛报名」" },
          dueAt: { type: "string", description: "YYYY-MM-DD 或 null" },
        },
        required: ["goal"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "广泛网页搜索（真实搜索引擎），用于用户要求网页搜索/跨源收集求职、比赛、科研等公开信息。返回标题+链接+摘要。",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "为长任务制定分步计划（收集→核验→整合→总结→落库）。长任务先建计划再逐步执行，每步完成后更新；保证连续任务不丢记忆、不幻觉。",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "长任务总目标" },
          steps: { type: "array", items: { type: "string" }, description: "有序步骤" },
        },
        required: ["goal", "steps"],
      },
    },
  },
];