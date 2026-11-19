import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRunCwd, workspaceTools, executeWorkspaceTool } from "./workspace-tools.ts";

const calls: Array<{ program: string; argv: string[]; cwd: string }> = [];
const fakeFiles = {
  list: async () => ({ entries: [] }),
  search: async () => [],
  read: async () => ({ content: "" }),
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
