import path from "node:path";
import { createSchedulePreview } from "../core/schedule-import.ts";
import type { PersonalContextStore } from "../core/personal-context.ts";
import { text, tool, type WorkspaceTool } from "./workspace-tools.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";
import { detailsToScheduleCsv } from "./timetable-details.ts";

export function workspaceScheduleTools(store: PersonalContextStore, owner: string, files: WorkspaceFiles): WorkspaceTool[] {
  return [
    {
      definition: tool("workspace_terms", "列出本地课表页的学期和教学周，用以为导入选择正确学期。", {}, []),
      capability: "host.schedule",
      execute: async () => (await store.listTerms(owner)).slice(0, 20),
    },
    {
      definition: tool("workspace_timetable_export", "将真实课表详情记录转换为 CSV。输入 JSON 数组字段为 course、weeks、periods、time、campus、room，只接受已有详情。", { source: text, output: text }, ["source", "output"]),
      capability: "host.schedule",
      privateSource: true,
      approval: (args) => `读取课表详情 ${args.source} 并导出 ${args.output}`,
      execute: async ({ source, output }) => {
        if (path.extname(String(source)).toLowerCase() !== ".json" || path.extname(String(output)).toLowerCase() !== ".csv") throw new Error("请选择 JSON 详情文件与 CSV 导出路径");
        const csv = detailsToScheduleCsv(JSON.parse(await files.readText(String(source))));
        return { ...await files.write(String(output), csv), rows: csv.trimEnd().split("\n").length - 1 };
      },
    },
    {
      definition: tool("workspace_schedule_preview", "将工作区里的 CSV 或 ICS 课表生成 CampusMate 导入预览。必须把工具返回的链接交给用户确认。", { path: text, termId: text }, ["path", "termId"]),
      capability: "host.schedule",
      privateSource: true,
      approval: (args) => `从 ${args.path} 创建学期 ${args.termId} 的课表预览`,
      execute: async (args) => {
        const name = String(args.path);
        const ext = path.extname(name).toLowerCase();
        if (ext !== ".csv" && ext !== ".ics") throw new Error("请选择工作区内的 CSV 或 ICS");
        const term = (await store.listTerms(owner)).find((item) => item.id === args.termId);
        if (!term) throw new Error("请先选择本地课表页中的真实学期");
        const result = await createSchedulePreview(store, owner, term, {
          format: ext === ".csv" ? "csv" : "ics", data: await files.readText(name), sourceName: path.basename(name),
        });
        return { jobId: result.jobId, previewUrl: `/calendar?import=${result.jobId}`, courses: result.preview.schedules.length,
          errors: result.preview.errors.slice(0, 10), errorCount: result.preview.errors.length,
          overlaps: result.preview.conflicts.length, duplicates: result.preview.duplicates, confirmed: false };
      },
    },
  ];
}
