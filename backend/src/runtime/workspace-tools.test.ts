import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRunCwd, workspaceTools, executeWorkspaceTool } from "./workspace-tools.ts";

const calls: Array<{ program: string; argv: string[]; cwd: string }> = [];
const skillText = "---\nname: env-setup\ndescription: 环境配置与抓取准备\n---\n\n# 零配置环境 setup\n正文步骤";
const fakeFiles = {
  list: async (relative: string) => ({ entries: relative === "skills" ? [{ name: "env-setup", kind: "directory" }, { name: "notes.txt", kind: "file" }] : [] }),
  search: async () => [],
  read: async () => ({ content: "" }),
  readText: async (relative: string) => { if (relative === "skills/env-setup/SKILL.md") return skillText; throw new Error("ENOENT"); },
  write: async () => ({ path: "x" }),
  run: async (program: string, argv: string[], cwd: string) => { calls.push({ program, argv, cwd }); return { exitCode: 0, stdout: "", stderr: "" }; },
} as unknown as Parameters<typeof workspaceTools>[0];

test("默认 cwd：运行工作区脚本时落在脚本所在目录，显式 cwd 优先", async () => {
  assert.equal(defaultRunCwd("python3", ["data/make_docx.py"]), "data");
  assert.equal(defaultRunCwd("python3", ["-c", "print(1)"]), ".");
  assert.equal(defaultRunCwd("scripts/tool.sh", []), "scripts");
  assert.equal(defaultRunCwd("python3", ["-m", "pytest"]), ".");
  assert.equal(defaultRunCwd("/abs/script.py", []), ".");
  assert.equal(defaultRunCwd("python3", ["../escape.py"]), ".");
  assert.equal(defaultRunCwd("python3", ["data/input.xlsx", "out.csv"]), ".");

  const run = workspaceTools(fakeFiles).find((item) => item.definition.function.name === "workspace_run")!;
  calls.length = 0;
  await executeWorkspaceTool(run, { program: "python3", argv: ["data/make_docx.py"] });
  assert.deepEqual(calls[0], { program: "python3", argv: ["data/make_docx.py"], cwd: "data" });
  await executeWorkspaceTool(run, { program: "python3", argv: ["data/make_docx.py"], cwd: "tmp" });
  assert.deepEqual(calls[1], { program: "python3", argv: ["data/make_docx.py"], cwd: "tmp" });
  await executeWorkspaceTool(run, { program: "python3", argv: ["-c", "print(1)"] });
  assert.deepEqual(calls[2], { program: "python3", argv: ["-c", "print(1)"], cwd: "." });
});
test("todo_write 整表替换：校验条目并反馈进度", async () => {
  const todo = workspaceTools(fakeFiles).find((item) => item.definition.function.name === "todo_write")!;
  const ok = JSON.parse(await executeWorkspaceTool(todo, { todos: [
    { content: "读取输入", status: "completed" },
    { content: "生成 report.docx", status: "in_progress" },
  ] })) as { ok: boolean; progress: string; next: string; todos: unknown[] };
  assert.equal(ok.ok, true);
  assert.equal(ok.progress, "1/2");
  assert.equal(ok.next, "生成 report.docx");
  assert.equal(ok.todos.length, 2);
  const empty = JSON.parse(await executeWorkspaceTool(todo, { todos: [] })) as { ok?: boolean; progress?: string };
  assert.equal(empty.progress, "0/0");
  const bad = JSON.parse(await executeWorkspaceTool(todo, { todos: [{ content: "", status: "pending" }] })) as { error?: string };
  assert.match(String(bad.error), /第 1 条/);
  const badStatus = JSON.parse(await executeWorkspaceTool(todo, { todos: [{ content: "x", status: "done" }] })) as { error?: string };
  assert.ok(badStatus.error);
});
test("skills_list / skills_read 渐进披露工作区技能，默认不暴露", async () => {
  const without = workspaceTools(fakeFiles).map((item) => item.definition.function.name);
  assert.ok(!without.includes("skills_list"));
  const tools = workspaceTools(fakeFiles, { includeSkills: true });
  const list = tools.find((item) => item.definition.function.name === "skills_list")!;
  const read = tools.find((item) => item.definition.function.name === "skills_read")!;
  const listed = JSON.parse(await executeWorkspaceTool(list, {})) as { entries: Array<{ name: string; description: string }>; count: number };
  assert.equal(listed.count, 1);
  assert.equal(listed.entries[0].name, "env-setup");
  assert.match(listed.entries[0].description, /环境配置/);
  const body = JSON.parse(await executeWorkspaceTool(read, { name: "env-setup" })) as { content: string; path: string };
  assert.match(body.content, /正文步骤/);
  assert.equal(body.path, "skills/env-setup/SKILL.md");
  const missing = JSON.parse(await executeWorkspaceTool(read, { name: "no-such" })) as { error?: string };
  assert.match(String(missing.error), /技能不存在/);
  const traversal = JSON.parse(await executeWorkspaceTool(read, { name: "../x" })) as { error?: string };
  assert.ok(traversal.error);
  const ok = JSON.parse(await executeWorkspaceTool(list, {})) as { count: number };
  assert.equal(ok.count, 1);
});
