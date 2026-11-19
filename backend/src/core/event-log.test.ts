import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySessionLog, StoreSessionLog, appendEvents, deriveMessages, replay, repairEvents, type SessionEvent } from "./event-log.ts";
import { validatePairing } from "./context.ts";
import type { ToolCall } from "./types.ts";

const toolCall = (id: string, name = "workspace_read"): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify({ path: "a.txt" }) } });

function baseEvents(): SessionEvent[] {
  return [
    { type: "turn/start", turnId: "t1", user: "读取文件并总结", at: 1 },
    { type: "step/start", turnId: "t1", step: 0, at: 2 },
    { type: "user/message", content: "读取 a.txt 并总结", at: 3 },
    { type: "assistant/message", content: "", toolCalls: [toolCall("c1")], at: 4 },
    { type: "tool/call", callId: "c1", name: "workspace_read", args: { path: "a.txt" }, at: 5 },
    { type: "tool/result", callId: "c1", content: JSON.stringify({ content: "hello" }), ok: true, at: 6 },
    { type: "assistant/message", content: "文件内容是 hello。", at: 7 },
    { type: "turn/end", turnId: "t1", reason: "completed", at: 8 },
  ];
}

test("deriveMessages 是事件日志的纯投影，配对完整", () => {
  const events = baseEvents();
  const messages = deriveMessages(events);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(messages[1].tool_calls?.[0].id, "c1");
  assert.equal(messages[2].tool_call_id, "c1");
  assert.equal(messages[2].content, JSON.stringify({ content: "hello" }));
  assert.equal(validatePairing(messages).ok, true);
  assert.deepEqual(deriveMessages(events), messages);
});

test("replay 恢复开放 turn 与未完成工具调用", () => {
  const events = baseEvents().slice(0, 6);
  const state = replay(events);
  assert.equal(state.openTurn, true);
  assert.equal(state.openTurnId, "t1");
  assert.equal(state.pendingCalls.length, 0);
  const interrupted = [...events.slice(0, 5)];
  const interruptedState = replay(interrupted);
  assert.equal(interruptedState.openTurn, true);
  assert.deepEqual(interruptedState.pendingCalls, [{ callId: "c1", name: "workspace_read" }]);
});

test("repairEvents 幂等补齐未完成工具结果与 interrupted turn", () => {
  const events = baseEvents().slice(0, 5);
  const suffix = repairEvents(events, () => 100);
  assert.equal(suffix.length, 2);
  assert.equal(suffix[0].type, "tool/result");
  assert.equal((suffix[0] as Extract<SessionEvent, { type: "tool/result" }>).ok, false);
  assert.equal(suffix[1].type, "turn/end");
  assert.equal((suffix[1] as Extract<SessionEvent, { type: "turn/end" }>).reason, "interrupted");
  const repaired = [...events, ...suffix];
  assert.equal(validatePairing(deriveMessages(repaired)).ok, true);
  assert.equal(replay(repaired).openTurn, false);
  assert.deepEqual(repairEvents(repaired, () => 101), []);
  assert.deepEqual(repairEvents(baseEvents(), () => 102), []);
});

test("InMemorySessionLog 追加后可按序重放", async () => {
  const log = new InMemorySessionLog();
  for (const event of baseEvents()) await log.append(event);
  const state = replay(log.events());
  assert.equal(state.messages.length, 4);
  assert.equal(state.openTurn, false);
  assert.equal(state.lastStep, 0);
});

test("appendEvents 批量追加保持顺序", async () => {
  const log = new InMemorySessionLog();
  const appended = await appendEvents(log, baseEvents());
  assert.equal(appended, 8);
  assert.equal(log.events()[0].type, "turn/start");
  assert.equal(log.events().at(-1)?.type, "turn/end");
});
test("StoreSessionLog 持久化并跨实例重建连续事件流", async () => {
  const rows: Array<{ taskId: string; userId: string; type: string; payload: Record<string, unknown> }> = [];
  const store = {
    async appendEvent(input: { taskId: string; userId: string; type: "session.event"; payload: { event: SessionEvent } }) { rows.push(input as unknown as { taskId: string; userId: string; type: string; payload: Record<string, unknown> }); },
    async listEvents(taskId: string) { return rows.filter((row) => row.taskId === taskId); },
  };
  const log = await StoreSessionLog.load(store, "task1", "u1");
  await log.append({ type: "turn/start", turnId: "t1", user: "读取文件", at: 1 });
  await log.append({ type: "user/message", content: "读取文件", at: 2 });
  const reloaded = await StoreSessionLog.load(store, "task1", "u1");
  assert.equal(reloaded.events().length, 2);
  assert.equal(reloaded.events()[0].type, "turn/start");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, "session.event");
});

