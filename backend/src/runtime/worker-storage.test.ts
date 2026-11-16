import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "./worker.ts";
import { InMemoryStore } from "./store.ts";

test("storage outage after a saved checkpoint pauses rather than failing model acceptance", async () => {
  const store = new InMemoryStore();
  const task = await store.createTask({ userId: "fixture", title: "collect information" });
  let unavailable = false;
  const get = store.getTask.bind(store);
  store.getTask = async id => {
    if (unavailable) { unavailable = false; throw Object.assign(new Error("数据库连接暂时不可用，请稍后恢复任务"), { name: "StorageUnavailableError" }); }
    return get(id);
  };
  let rounds = 0;
  const worker = new Worker({ store, workerId: "w", heartbeatMs: 1000000,
    tools: [{ type: "function", function: { name: "web_search", description: "search", parameters: { type: "object", properties: {} } } }],
    buildSystem: () => "s", executeTool: async () => JSON.stringify({ results: [{ title: "saved observation" }] }),
    transport: { async chat() {
      rounds++;
      if (rounds === 1) return { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }], model: "contract", usage: { input: 1, output: 1 } };
      unavailable = true; return { content: "not yet committed", toolCalls: [], model: "contract", usage: { input: 1, output: 1 } };
    } },
  });
  await worker.tick();
  assert.equal((await get(task.id))?.status, "paused");
  assert((await store.latestCheckpoint(task.id))?.state.messages.some(m => m.role === "tool" && String(m.content).includes("saved observation")));
  const events = await store.listEvents(task.id);
  assert(!events.some(e => e.type === "eval.failed"));
  assert(events.some(e => e.type === "task.needs_input" && e.payload.reason === "storage_unavailable"));
});

test("idle Worker survives a transient claim outage and continues polling", async () => {
  const store = new InMemoryStore(); const control = new AbortController(); let claims = 0;
  store.claimNext = async () => { claims++; if (claims === 1) throw Object.assign(new Error("storage"), { name: "StorageUnavailableError" }); control.abort(); return null; };
  const worker = new Worker({ store, tools: [], buildSystem: () => "s", executeTool: async () => "{}" });
  await worker.run({ signal: control.signal, pollMs: 1 }); assert.equal(claims, 2);
});
test("idle Worker survives an interrupted claim without replaying that transaction", async () => {
  const store = new InMemoryStore(); const control = new AbortController(); let claims = 0;
  store.claimNext = async () => { claims++; if (claims === 1) throw new Error("Connection terminated unexpectedly"); control.abort(); return null; };
  const worker = new Worker({ store, tools: [], buildSystem: () => "s", executeTool: async () => "{}" });
  await worker.run({ signal: control.signal, pollMs: 1 }); assert.equal(claims, 2);
});

test("storage pause cannot overwrite a newer worker's lease", async () => {
  const store = new InMemoryStore(); const task = await store.createTask({ userId: "fixture", title: "x" });
  const get = store.getTask.bind(store); let interrupt = false;
  store.getTask = async id => {
    if (interrupt) {
      interrupt = false; const current = (await get(id))!;
      await store.updateTask(id, { lease: { ...current.lease, owner: "new-worker" }, attempt: current.attempt + 1 });
      throw Object.assign(new Error("storage"), { name: "StorageUnavailableError" });
    }
    return get(id);
  };
  const worker = new Worker({ store, workerId: "old-worker", heartbeatMs: 1000000, tools: [], buildSystem: () => "s", executeTool: async () => "{}",
    transport: { async chat() { interrupt = true; return { content: "draft", toolCalls: [], model: "contract", usage: { input: 1, output: 1 } }; } },
  });
  await worker.tick(); const current = (await get(task.id))!;
  assert.equal(current.status, "running"); assert.equal(current.lease.owner, "new-worker");
  assert(!(await store.listEvents(task.id)).some(e => e.type === "task.needs_input"));
});

test("heartbeat storage outage pauses instead of reporting cancellation", async () => {
  const store = new InMemoryStore(); const task = await store.createTask({ userId: "fixture", title: "x" });
  store.renewLease = async () => { throw Object.assign(new Error("storage"), { name: "StorageUnavailableError" }); };
  const worker = new Worker({ store, workerId: "w", heartbeatMs: 5, tools: [], buildSystem: () => "s", executeTool: async () => "{}",
    transport: { async chat(request) {
      await new Promise<void>(resolve => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { content: "", toolCalls: [], model: "contract", usage: { input: 1, output: 0 } };
    } },
  });
  await worker.tick(); assert.equal((await store.getTask(task.id))?.status, "paused");
  assert((await store.listEvents(task.id)).some(e => e.payload.reason === "storage_unavailable"));
});
