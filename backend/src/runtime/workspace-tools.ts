import type { Task, ToolDef } from "../core/types.ts";
import type { CapabilityId, CapabilityRegistry } from "../core/capability.ts";
import { argumentError } from "../core/tool-arguments.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";

export const text = { type: "string" };
const number = { type: "integer" };

export function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

export type WorkspaceTool = {
  definition: ToolDef;
  capability: CapabilityId;
  privateSource?: boolean;
  approval?: (args: Record<string, unknown>) => string;
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  runForTask?: (task: Task, args: Record<string, unknown>) => Promise<unknown>;
};

function bounded(value: unknown, fallback: number, min: number, max: number) {
  const count = value ?? fallback;
  if (!Number.isInteger(count) || Number(count) < min || Number(count) > max) throw new Error(`数值应在 ${min}–${max} 之间`);
  return Number(count);
}

// 运行工作区内的脚本文件时，未显式给 cwd 则默认在该脚本所在目录执行。
// 依据：脚本内相对路径产物应落在输入文件所在目录（OfficeBench 2-21/0 实测把 docx 写到了工作区根目录）。
// 只对安全的工作区相对路径生效；解释器参数（-c/-m）、绝对路径和含 .. 的路径保持原默认值。
const RUN_SCRIPT_EXTENSIONS = /\.(?:py|js|mjs|cjs|ts|sh|bash|rb|pl|php|ps1|lua|r)$/i;
export function defaultRunCwd(program: string, argv: unknown): string {
  const candidates = [program, ...(Array.isArray(argv) ? argv : [])];
  for (const value of candidates) {
    if (typeof value !== "string" || !value) continue;
    if (/^(?:-|\/|~|\\)/.test(value) || value.includes("..")) continue;
    if (!/[\\/]/.test(value) || !RUN_SCRIPT_EXTENSIONS.test(value)) continue;
    const parts = value.split(/[\\/]+/).filter(Boolean);
    if (parts.length < 2) continue;
    return parts.slice(0, -1).join("/");
  }
  return ".";
}

export function workspaceTools(files: WorkspaceFiles): WorkspaceTool[] {
  return [
    {
      definition: tool("workspace_list", "列出本地工作区内一个目录。path 为相对路径，当前目录填 .。", { path: text }, []),
      capability: "host.fs.read",
      execute: (args) => files.list(String(args.path ?? ".")),
    },
    {
      definition: tool("workspace_search", "在本地工作区按关键词查找文本，返回有限的文件名、行号和片段。", { path: text, query: text }, ["query"]),
      capability: "host.fs.read",
      execute: (args) => {
        const query = String(args.query).trim();
        if (query.length < 1 || query.length > 200) throw new Error("搜索词长度应在 1–200 之间");
        return files.search(String(args.path ?? "."), query);
      },
    },
    {
      definition: tool("workspace_read", "读取本地 UTF-8 文件的指定行。path 为相对路径；start 从 1 开始，count 最多 200。", { path: text, start: number, count: number }, ["path"]),
      capability: "host.fs.read",
      execute: (args) => files.read(String(args.path), bounded(args.start, 1, 1, 262144), bounded(args.count, 80, 1, 200)),
    },
    {
      definition: tool("workspace_write", "在本地工作区写入 UTF-8 文本文件，已有文件会被覆盖。使用相对路径，父目录须存在。", { path: text, content: text }, ["path", "content"]),
      capability: "host.fs.write",
      approval: (args) => `写入工作区文件 ${args.path}（${Buffer.byteLength(String(args.content))} 字节）`,
      execute: (args) => files.write(String(args.path), String(args.content)),
    },
    {
      definition: tool("workspace_run", "在本地执行一个程序。program 为可执行文件名或工作区相对路径，argv 为参数数组，cwd 为工作区相对目录；省略 cwd 时若运行的是工作区内的脚本/程序文件，默认在该文件所在目录执行。检查退出码和产物，并核对产物实际路径。", { program: text, argv: { type: "array", items: text }, cwd: text, timeoutMs: number }, ["program", "argv"]),
      capability: "host.terminal",
      approval: (args) => `在 ${args.cwd ?? defaultRunCwd(String(args.program ?? ""), args.argv)} 执行 ${args.program} ${JSON.stringify(args.argv)}`.slice(0, 4000),
      execute: (args) => {
        const program = String(args.program), argv = args.argv as string[];
        if (!program || program.length > 300 || program.includes("\0") || argv.length > 60 || argv.some((arg) => arg.includes("\0") || arg.length > 4000)) throw new Error("可执行文件或参数超出限制");
        const cwd = args.cwd === undefined || args.cwd === null || args.cwd === "" ? defaultRunCwd(program, argv) : String(args.cwd);
        return files.run(program, argv, cwd, bounded(args.timeoutMs, 15000, 500, 45000));
      },
    },
  ];
}

export function registerWorkspaceTools(registry: CapabilityRegistry, tools: WorkspaceTool[]) {
  const capabilities = new Map<CapabilityId, string[]>();
  for (const item of tools) {
    const names = capabilities.get(item.capability) ?? [];
    names.push(item.definition.function.name);
    capabilities.set(item.capability, names);
  }
  for (const [id, names] of capabilities) registry.register({
    id, runtime: "dev", tools: names, permissions: ["local-workspace"],
    healthCheck: async () => ({ available: true, checkedAt: Date.now() }),
  });
}

export async function executeWorkspaceTool(item: WorkspaceTool, args: Record<string, unknown>, task?: Task): Promise<string> {
  const invalid = argumentError(item.definition.function.parameters, args);
  if (invalid) return JSON.stringify({ error: invalid, class: "tool_validation" });
  try { return JSON.stringify(await (item.runForTask && task ? item.runForTask(task, args) : item.execute(args))); }
  catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : String(error) }); }
}
