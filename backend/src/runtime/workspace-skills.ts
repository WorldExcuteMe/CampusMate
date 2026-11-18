import { text, tool, type WorkspaceTool } from "./workspace-tools.ts";

const SKILLS = {
  programming: {
    description: "在工作区定位、修改、执行和验证代码",
    instructions: "先写出目标和可检查的通过条件。用 workspace_list 与 workspace_search 定位入口、调用方和现有测试，只阅读命中的文件片段。按小步写入脚本，先用小样本验证，再处理完整输入。记录退出码与文件，重读交付结果。遇到不确定的上一次写入，先检查工作区状态。",
  },
  "campus-research": {
    description: "公开信息核验与授权高校网页读取",
    instructions: "公开资料先 web_search，再 web_fetch 官方正文。对已登录网页使用工作区的 campus_browser。用户在浏览器里完成登录，核对域名和页面来源，逐个读取目标页。遇到需要登录或内容不可读时报告实际状态。",
  },
  "group-notices": {
    description: "指定 QQ 或微信来源的群通知整理",
    instructions: "先核对目标群及导出边界，再用 workspace_group_export 读取已授权导出。返回可核对的日期和证据摘要。区分已过期、仍有效和无法核实的事项，获取不到真实导出时报告缺口。",
  },
  timetable: {
    description: "校验并导入课表",
    instructions: "先用 workspace_terms 定位学期。核对来源、教学周、上课时间、日期和地点。逐周页面只报告实际可见课程。收集课程详情后可用 workspace_timetable_export 从 JSON 转为 CSV，再用 workspace_schedule_preview 生成导入预览。把预览链接原样交给用户确认，只有课表页面保存及回读成功才宣称已导入。",
  },
  documents: {
    description: "写作、核对并导出 Markdown、Word 或 PDF",
    instructions: "确认受众、目的、必需章节及真实来源。用提纲约束正文，将内容写入 document_create。通过 document_inspect 核对章节，再运行 document_export。只有工具返回授权下载时才宣布可下载。",
  },
} satisfies Record<string, { description: string; instructions: string }>;

export const builtinSkillCatalog = Object.entries(SKILLS).map(([name, detail]) => `${name}（${detail.description}）`).join("、");

interface RepositoryMatch { full_name?: string; html_url?: string; description?: string; license?: { spdx_id?: string }; }

export function builtinWorkspaceTools(fetchImpl: typeof fetch = fetch): WorkspaceTool[] {
  return [
    {
      definition: tool("skill_open", "读取一个内置技能的执行说明。", { name: { ...text, enum: Object.keys(SKILLS) } }, ["name"]),
      capability: "skills.builtin",
      execute: ({ name }) => SKILLS[name as keyof typeof SKILLS],
    },
    {
      definition: tool("github_search", "只读搜索公开 GitHub 仓库，返回最多五条仓库名、链接、用途和许可证。勿发送私密文本或凭据。", { query: text }, ["query"]),
      capability: "skills.builtin",
      execute: async ({ query }) => {
        const q = String(query).trim();
        if (q.length < 2 || q.length > 160) throw new Error("请提供 2–160 字符的公开仓库检索词");
        const url = new URL("https://api.github.com/search/repositories");
        url.search = new URLSearchParams({ q: q + " is:public", per_page: "5" }).toString();
        const response = await fetchImpl(url, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "CampusMate" },
          redirect: "error", signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error(`GitHub 公开搜索返回 HTTP ${response.status}`);
        const body = await response.json() as { items?: RepositoryMatch[] };
        return { results: (body.items ?? []).slice(0, 5).map((row) => ({
          name: row.full_name, url: row.html_url, description: row.description?.slice(0, 200), license: row.license?.spdx_id,
        })) };
      },
    },
  ];
}
