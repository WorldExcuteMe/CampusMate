// 评测侧 durable store 契约（不调用真实模型）：
// 1) 进程 A 用 PGlite 持久库跑到 budget 暂停（checkpoint 落盘），释放进程；
// 2) 进程 B 重新打开同一目录，resumeSessionTask 后继续，验证任务成功且副作用只执行一次。
// 3) eval CLI 的 --store pglite / --resume-session last 两阶段（脚本模型，api-memory）可跨进程续同一会话。
// 该测试只读复用产品 runtime/app-context，不改 core/runtime。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BACKEND = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const CORE_TYPES = new URL("../core/types.ts", import.meta.url).href;
const CLOUD_TOOLS = new URL("../core/cloud-tools.ts", import.meta.url).href;
const WORKER = new URL("../runtime/worker.ts", import.meta.url).href;
const DURABLE = new URL("./targets/durable-store.ts", import.meta.url).href;

const PHASE_A = `
import { openDurableAppContext, ensureDurableUser } from ${JSON.stringify(DURABLE)};
import { DEFAULT_BUDGET } from ${JSON.stringify(CORE_TYPES)};
import { CLOUD_TOOLS, executeCloudTool } from ${JSON.stringify(CLOUD_TOOLS)};
import { Worker } from ${JSON.stringify(WORKER)};
import { randomUUID } from "node:crypto";
const [dir] = process.argv.slice(1);
const owner = "11111111-1111-4111-8111-111111111111";
const { ctx, pool } = await openDurableAppContext({ NODE_ENV: "test", DOCUMENT_PDF_ENABLED: "0" }, dir);
try {
  await ensureDurableUser(pool, owner);
  const session = await ctx.sessionStore.create({ userId: owner });
  const { task } = await ctx.store.createSessionTask(
    { userId: owner, sessionId: session.id, turnId: randomUUID(), title: "durable-resume-fixture", budget: { ...DEFAULT_BUDGET, toolCalls: 1 } },
    ctx.sessionStore,
  );
  let step = 0;
  const transport = {
    async chat() {
      step += 1;
      if (step === 1) {
        return { content: "", toolCalls: [{ id: "fixture-call-1", type: "function", function: { name: "save_to_inbox", arguments: JSON.stringify({ title: "durable resume fixture", rawText: "【durable resume fixture】明天下午三点开会。" }) } }], usage: { input: 1, output: 1 }, model: "fixture" };
      }
      return { content: "第一阶段不应到此", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" };
    },
  };
  const execute = async (current, name, args) => executeCloudTool(name, args, {
    taskId: current.id, userId: current.userId, campusRecords: ctx.campusRecords, businessStore: ctx.businessStore,
  });
  await new Worker({ store: ctx.store, sessionStore: ctx.sessionStore, transport, tools: CLOUD_TOOLS, capabilityRegistry: ctx.capabilityRegistry, buildSystem: () => "fixture", executeTool: execute, concurrency: 1 }).tick();
  const paused = await ctx.store.getTask(task.id);
  const checkpoint = await ctx.store.latestCheckpoint(task.id);
  process.stdout.write(JSON.stringify({ owner, sessionId: session.id, taskId: task.id, status: paused?.status, checkpoint: Boolean(checkpoint), checkpointMessages: checkpoint?.state.messages.length ?? 0 }) + "\\n");
} finally {
  await pool.end();
}
`;

const PHASE_B = `
import { openDurableAppContext } from ${JSON.stringify(DURABLE)};
import { DEFAULT_BUDGET } from ${JSON.stringify(CORE_TYPES)};
import { CLOUD_TOOLS } from ${JSON.stringify(CLOUD_TOOLS)};
import { Worker } from ${JSON.stringify(WORKER)};
const [dir, payload] = process.argv.slice(1);
const state = JSON.parse(payload);
const { ctx, pool } = await openDurableAppContext({ NODE_ENV: "test", DOCUMENT_PDF_ENABLED: "0" }, dir);
try {
  const before = await ctx.store.getTask(state.taskId);
  const restored = await ctx.store.resumeSessionTask(state.taskId, state.owner, DEFAULT_BUDGET);
  let executions = 0;
  const transport = {
    async chat() { return { content: "恢复完成", toolCalls: [], usage: { input: 2, output: 1 }, model: "fixture" }; },
  };
  await new Worker({ store: ctx.store, sessionStore: ctx.sessionStore, transport, tools: CLOUD_TOOLS, capabilityRegistry: ctx.capabilityRegistry, buildSystem: () => "fixture", executeTool: async () => { executions += 1; return '{"ok":true}'; }, concurrency: 1 }).tick();
  const task = await ctx.store.getTask(state.taskId);
  const inbox = await ctx.campusRecords.listInbox(state.owner);
  const checkpoint = await ctx.store.latestCheckpoint(state.taskId);
  process.stdout.write(JSON.stringify({
    beforeStatus: before?.status, restoredStatus: restored.status, status: task?.status,
    reply: task?.result?.summary ?? null, executions, inbox: inbox.length,
    checkpointMessages: checkpoint?.state.messages.length ?? 0,
  }) + "\\n");
} finally {
  await pool.end();
}
`;

const CLI_CASE_A = {
  id: "CLIDUR-001", category: "tests", difficulty: "easy", source: "generated", tiers: ["api-memory"],
  prompt: "durable cli phase a",
  turns: [{ prompt: "durable cli phase a", script: [{ content: "阶段A脚本回复" }], checks: [{ kind: "status", in: ["succeeded"] }] }],
};
const CLI_CASE_B = {
  id: "CLIDUR-002", category: "tests", difficulty: "easy", source: "generated", tiers: ["api-memory"],
  prompt: "durable cli phase b",
  turns: [{ prompt: "durable cli phase b", script: [{ content: "阶段B脚本回复" }], checks: [{ kind: "status", in: ["succeeded"] }] }],
};

async function mkTemp(prefix: string) {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

test("PGlite durable store: phase A pauses to checkpoint, new process reopens and resumes without duplicate side effects", { timeout: 120_000 }, async () => {
  const root = await mkTemp("campusmate-durable-resume-");
  try {
    const storeDir = path.join(root, "store");
    const childA = await exec(process.execPath, ["--input-type=module", "-e", PHASE_A, storeDir], { cwd: BACKEND, timeout: 90_000, windowsHide: true, maxBuffer: 4_000_000 });
    const phaseA = JSON.parse(String(childA.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "{}");
    assert.equal(phaseA.status, "paused", `phase A status=${phaseA.status}`);
    assert.equal(phaseA.checkpoint, true, "phase A must persist a checkpoint before exit");
    assert.ok(phaseA.checkpointMessages > 0);
    const childB = await exec(process.execPath, ["--input-type=module", "-e", PHASE_B, storeDir, JSON.stringify(phaseA)], { cwd: BACKEND, timeout: 90_000, windowsHide: true, maxBuffer: 4_000_000 });
    const phaseB = JSON.parse(String(childB.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "{}");
    assert.equal(phaseB.beforeStatus, "paused", "a new process sees the paused task from disk");
    assert.equal(phaseB.status, "succeeded", `phase B: ${JSON.stringify(phaseB)}`);
    assert.equal(phaseB.executions, 0, "resumed task must not re-execute the already committed tool call");
    assert.equal(phaseB.inbox, 1, "exactly one side effect survives the restart");
    assert.equal(phaseA.sessionId !== undefined, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("eval CLI --store pglite: two processes resume the same durable session without duplicate turns", { timeout: 180_000 }, async () => {
  const root = await mkTemp("campusmate-durable-cli-");
  try {
    const suitePath = path.join(root, "suite.json");
    const dataset = { schemaVersion: 1, id: "durable-cli-fixture", name: "durable cli fixture", source: "generated", cases: [CLI_CASE_A, CLI_CASE_B] };
    await writeFile(suitePath, JSON.stringify(dataset, null, 2));
    const storeDir = path.join(root, "store");
    const runs = path.join(root, "runs");
    const runA = await exec(process.execPath, ["scripts/eval.ts", "run", "--suite", suitePath, "--case", "CLIDUR-001", "--target", "api-memory", "--store", "pglite", "--store-dir", storeDir, "--runs", runs, "--label", "durable-cli-a"], { cwd: BACKEND, timeout: 90_000, windowsHide: true, maxBuffer: 4_000_000 });
    assert.match(runA.stdout, /durable session=/, runA.stdout);
    const handoffA = JSON.parse(await readFile(path.join(storeDir, "durable-session.json"), "utf8"));
    assert.ok(handoffA.sessionId, "phase A handoff records the session id");
    assert.ok(handoffA.userId, "phase A handoff records the owner");
    const runB = await exec(process.execPath, ["scripts/eval.ts", "run", "--suite", suitePath, "--case", "CLIDUR-002", "--target", "api-memory", "--store", "pglite", "--store-dir", storeDir, "--resume-session", "last", "--runs", runs, "--label", "durable-cli-b"], { cwd: BACKEND, timeout: 90_000, windowsHide: true, maxBuffer: 4_000_000 });
    assert.match(runB.stdout, /durable session=/, runB.stdout);
    const handoffB = JSON.parse(await readFile(path.join(storeDir, "durable-session.json"), "utf8"));
    assert.equal(handoffB.sessionId, handoffA.sessionId, "phase B continued the same session");
    // 用同一 durable 目录核对持久化结果：2 个任务、2 条用户消息、1 个 session。
    const inspect = `
import { openDurableAppContext } from ${JSON.stringify(DURABLE)};
import { PGlitePool } from ${JSON.stringify(new URL("../runtime/pglite-pool.ts", import.meta.url).href)};
const [dir, owner, sessionId] = process.argv.slice(1);
const { ctx, pool } = await openDurableAppContext({ NODE_ENV: "test" }, dir);
try {
  const tasks = await ctx.store.listTasksByUser(owner);
  const messages = await ctx.sessionStore.listMessages(owner, sessionId); const userMessages = messages.filter(m => m.role === "user").length;
  const sessions = await ctx.sessionStore.list(owner);
  process.stdout.write(JSON.stringify({ tasks: tasks.length, messages: messages.length, sessions: sessions.length, taskStatuses: tasks.map(t => t.status), contents: messages.map(m => m.content), userMessages, userContents: messages.filter(m => m.role === "user").map(m => m.content) }) + "\\n");
} finally { await pool.end(); }
`;
    const inspectRun = await exec(process.execPath, ["--input-type=module", "-e", inspect, storeDir, handoffA.userId, handoffA.sessionId], { cwd: BACKEND, timeout: 90_000, windowsHide: true, maxBuffer: 4_000_000 });
    const restored = JSON.parse(String(inspectRun.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "{}");
    assert.equal(restored.tasks, 2, "two turns persisted as two tasks");
    assert.equal(restored.sessions, 1, "no duplicate session was created for the resume phase");
    assert.equal(restored.userMessages, 2, "no duplicate user turns: exactly one user message per turn");
    assert.ok(restored.taskStatuses.every((status: string) => status === "succeeded"), JSON.stringify(restored));
    assert.deepEqual(restored.userContents.slice().sort(), ["durable cli phase a", "durable cli phase b"].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("eval CLI rejects --store pglite without --store-dir and --resume-session without durable store", { timeout: 60_000 }, async () => {
  let noDirError: { code?: number; stderr?: string } | undefined;
  try {
    await exec(process.execPath, ["scripts/eval.ts", "run", "--suite", "baseline", "--target", "api-memory", "--store", "pglite"], { cwd: BACKEND, timeout: 30_000, windowsHide: true });
  } catch (error) {
    noDirError = error as { code?: number; stderr?: string };
  }
  assert.ok(noDirError && noDirError.code !== 0, "missing --store-dir must fail");
  assert.match(String(noDirError?.stderr), /store-dir/);
  let noStoreError: { code?: number; stderr?: string } | undefined;
  try {
    await exec(process.execPath, ["scripts/eval.ts", "run", "--suite", "baseline", "--target", "api-memory", "--resume-session", "last"], { cwd: BACKEND, timeout: 30_000, windowsHide: true });
  } catch (error) {
    noStoreError = error as { code?: number; stderr?: string };
  }
  assert.ok(noStoreError && noStoreError.code !== 0, "resume without durable store must fail");
  assert.match(String(noStoreError?.stderr), /store pglite/);
});





