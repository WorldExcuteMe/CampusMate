import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../api/server.ts";
import { signJwt } from "../api/jwt.ts";
import { InMemoryStore } from "./store.ts";
import { startLocalApp } from "./local-app.ts";
import { groupExport } from "./workspace-group.ts";
import { detailsToScheduleCsv } from "./timetable-details.ts";
import { previewImport } from "../core/schedule-import.ts";
import type { LlmTransport } from "../core/llm.ts";

test("本地工作区按用户暴露目录和权限，权限默认请求批准", async (t) => {
  const secret = "workspace-test";
  const owner = "486ed2c8-a0cf-47c9-bc57-3607f153e907";
  const info = { owner, name: "消息整理", permission: "ask" as const };
  const localWorkspace = { info: () => info, setPermission: async () => undefined };
  const deps = { store: new InMemoryStore(), jwtSecret: secret, localWorkspace };
  const server = createApiServer(deps);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/v1/local-workspace";
  const headers = (sub: string) => ({ Authorization: "Bearer " + signJwt({ sub }, secret) });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: headers("other") })).status, 403);
  const response = await fetch(url, { headers: headers(owner) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { workspace: info });
});

test("本地 Agent 通过审批写入、运行脚本，重启后保留任务，另一目录隔离", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "campusmate-local-fixture-"));
  const a = path.join(tmp, "a"), b = path.join(tmp, "b"), webRoot = path.join(tmp, "web"), dataHome = path.join(tmp, "data");
  await Promise.all([a, b, webRoot].map((directory) => fs.mkdir(directory)));
  await fs.writeFile(path.join(webRoot, "index.html"), "<head></head><body>fixture</body>");
  const transport: LlmTransport = {
    async chat({ messages }) {
      const successful = messages.filter(m => m.role === "tool" && !String(m.content).includes("__approval_pending__"));
      const result = successful.at(-1);
      const common = { model: "fixture", usage: { input: 12, output: 3 } };
      if (successful.length >= 2) return { ...common, content: String(result?.content), toolCalls: [] };
      const name = successful.length ? "workspace_run" : "workspace_write";
      const args = successful.length
        ? { program: "node", argv: ["proof.mjs"] }
        : { path: "proof.mjs", content: "console.log('workspace-script-ok');" };
      return { ...common, content: "", toolCalls: [{ id: "tool-" + name, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
    },
  };
  let active: Awaited<ReturnType<typeof startLocalApp>> | undefined;
  t.after(async () => {
    await active?.close();
    const actual = await fs.realpath(tmp);
    assert.equal(path.dirname(actual), await fs.realpath(os.tmpdir()));
    await fs.rm(actual, { recursive: true, force: true });
  });
  async function open(directory: string) {
    active = await startLocalApp({ directory, webRoot, dataHome, port: 0, transport });
    const { baseUrl } = active;
    const html = await fetch(baseUrl + "/agent").then(r => r.text());
    const token = html.match(/name="campusmate-local-token" content="([^"]+)"/)?.[1];
    assert.ok(token);
    const req = (route: string, body?: unknown) => fetch(baseUrl + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const { workspace } = await req("/v1/local-workspace").then(r => r.json()) as { workspace: { owner: string; permission: string } };
    assert.equal((await fetch(baseUrl + "/agent", { headers: { Origin: "https://unrelated.test" } })).status, 403);
    return { req, workspace };
  }
  const first = await open(a);
  assert.equal(first.workspace.permission, "ask");
  const created = await first.req("/v1/tasks", { title: "执行本地脚本验证", intent: "编写脚本执行验证" });
  assert.equal(created.status, 201, await created.clone().text());
  const { taskId } = await created.json() as { taskId: string };
  const slug = "/v1/tasks/" + taskId;
  async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const data = await probe();
      if (data) return data;
      await delay(30);
    }
    throw new Error("等待工作区任务状态超时");
  }
  async function approve(toolName: string) {
    const approval = await waitFor(async () => {
      const { approvals } = await first.req("/v1/approvals").then(r => r.json()) as { approvals: { id: string; toolName: string }[] };
      const state = await first.req(slug).then(r => r.json()) as { task: { status: string } };
      return state.task.status === "needs_input" ? approvals.find(a => a.toolName === toolName) : undefined;
    });
    assert.ok(approval);
    assert.equal((await first.req("/v1/approvals/" + approval.id, { decision: "approved" })).status, 200);
    assert.equal((await first.req(slug + "/resume", {})).status, 200);
  }
  await assert.rejects(fs.stat(path.join(a, "proof.mjs")), { code: "ENOENT" });
  await approve("workspace_write");
  await approve("workspace_run");
  const finished = await waitFor(async () => {
    const { task } = await first.req(slug).then(r => r.json()) as { task: { status: string; result?: { summary: string } } };
    return task.status === "succeeded" || task.status === "failed" ? task : undefined;
  });
  assert.equal(finished.status, "succeeded", JSON.stringify(finished));
  assert.match(finished.result?.summary ?? "", /workspace-script-ok/);
  assert.match(await fs.readFile(path.join(a, "proof.mjs"), "utf8"), /workspace-script-ok/);
  assert.equal((await first.req("/v1/local-workspace", { permission: "full" })).status, 200);
  await active!.close(); active = undefined;
  const second = await open(b);
  assert.notEqual(second.workspace.owner, first.workspace.owner);
  assert.equal(second.workspace.permission, "ask");
  assert.equal((await second.req(slug)).status, 404);
  await active!.close(); active = undefined;
  const restarted = await open(a);
  assert.deepEqual(restarted.workspace, { ...first.workspace, permission: "full" });
  assert.equal((await restarted.req(slug)).status, 200);
});

test("群导出严格核对群标识并复用消息去重，返回有界记录", () => {
  const evidence = JSON.stringify({ uin: 123456, records: [
    { time: "2026-11-04 09:00:00", text: "通知：作业 11月10日提交" },
    { time: "2026-11-04 09:00:10", text: "通知：作业 11月10日提交" },
    { time: "2026-11-05 09:00:00", text: "讲座 18:00" },
    { time: "2026-11-04 10:00:00", text: "早上好" },
  ] });
  assert.throws(() => groupExport(evidence, "qq", "234567", 1), /群标识/);
  const result = groupExport(evidence, "qq", "123456", 1);
  assert.equal(result.matched, 2);
  assert.equal(result.records[0].time, "2026-11-05 09:00:00");
  assert.equal(result.truncated, true);
});

test("课程详情导出保留实际作息、单双周和跨周冲突，拒绝缺少来源字段", () => {
  const detail = { course: "数据结构", weeks: "1-8周（单）, 12周", periods: "周四 3~4节", time: "10:10 ~ 12:00", campus: "校区甲", room: '教学楼 "B111"' };
  const csv = detailsToScheduleCsv([detail, detail, { ...detail, course: "测试实验", weeks: "7周" }]);
  const result = previewImport("csv", csv, "2026-09-07", 24);
  assert.deepEqual(result.errors, []);
  assert.equal(result.schedules.length, 3);
  const [first] = result.schedules;
  assert.deepEqual([first.weekday, first.startWeek, first.endWeek, first.weekPattern, first.classroom], [4, 1, 8, "odd", detail.room]);
  assert.equal(result.conflicts.length, 1);
  assert.throws(() => detailsToScheduleCsv([{ ...detail, time: "" }]), /时间/);
});
