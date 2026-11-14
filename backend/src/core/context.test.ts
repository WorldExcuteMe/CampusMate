import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTurns, validatePairing, trimToBudget, composeContext, estimateTokens, messagesTokens } from "./context.ts";
import { InMemoryMemoryStore } from "./memory.ts";
import { buildContext, retrieveRelevantMemory, taskContextSummary } from "./context-builder.ts";
import type { ChatMessage } from "./types.ts";

const asst = (id: string): ChatMessage => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "t", arguments: "{}" } }] });
const tool = (id: string, content = "result"): ChatMessage => ({ role: "tool", content, tool_call_id: id });
const sys = (c: string): ChatMessage => ({ role: "system", content: c });
const usr = (c: string): ChatMessage => ({ role: "user", content: c });

test("groupTurns 把 assistant(tool_calls)+tool 结果归为一组", () => {
  const msgs = [sys("s"), usr("u"), asst("a"), tool("a"), tool("a"), asst("b"), tool("b"), usr("next")];
  const groups = groupTurns(msgs);
  assert.equal(groups.length, 5); // sys, usr, [asst a+2tool], [asst b+1tool], usr
  assert.equal(groups[2].length, 3);
  assert.equal(groups[3].length, 2);
});

test("validatePairing 检测孤儿 tool", () => {
  assert.equal(validatePairing([asst("a"), tool("a")]).ok, true);
  assert.equal(validatePairing([tool("a")]).ok, false); // 孤儿
  assert.equal(validatePairing([asst("a"), tool("b")]).orphans, 1);
});

test("trimToBudget 超窗压缩后配对完整（无孤儿 tool）", () => {
  // 构造大量轮次组，每组 assistant+tool，触发压缩。
  const msgs: ChatMessage[] = [sys("system")];
  for (let i = 0; i < 50; i++) { msgs.push(usr(`q${i}`), asst(`id${i}`), tool(`id${i}`, "x".repeat(2000))); }
  const cap = 20000; // 小窗口强制压缩
  const r = trimToBudget(msgs, cap, 0);
  assert.equal(r.compressed, true);
  assert.equal(validatePairing(r.messages).ok, true); // 关键：无孤儿
  assert.ok(messagesTokens(r.messages) <= cap);
});

test("composeContext 超窗按组保留近期，配对完整", () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 40; i++) { history.push(usr(`q${i}`), asst(`h${i}`), tool(`h${i}`, "y".repeat(1500))); }
  const r = composeContext({ system: "s", history, user: "current", cap: 15000 });
  assert.equal(r.compressed, true);
  assert.equal(validatePairing(r.messages).ok, true);
});

test("工具结果裁剪（spill）：较旧 tool 裁剪 head+tail，最新保留，不丢消息", () => {
  const big = "a".repeat(20000);
  const msgs = [sys("s"), asst("a"), tool("a", big), asst("b"), tool("b", big)];
  const r = trimToBudget(msgs, 1_000_000, 0); // 大窗口不压缩，仅 spill 较旧 tool
  assert.equal(r.messages.length, 5); // 不丢消息
  assert.equal(validatePairing(r.messages).ok, true);
  const tools = r.messages.filter((m) => m.role === "tool");
  assert.ok(tools[0].content.length < big.length); // 较旧被裁剪
  assert.match(String(tools[0].content), /省略/);
  assert.equal(tools[1].content.length, big.length); // 最新保留完整
});

test("记忆隔离：会话跨用户不可见，Episodic 跨任务不可见", async () => {
  const store = new InMemoryMemoryStore();
  await store.appendSession("s1", "u1", [usr("hello")]);
  assert.equal((await store.getSession("s1", "u1"))?.messages.length, 1);
  assert.equal(await store.getSession("s1", "u2"), null); // 跨用户
  await store.addEpisodic({ taskId: "t1", userId: "u1", eventSeq: 1, type: "llm.request" });
  await store.addEpisodic({ taskId: "t2", userId: "u1", eventSeq: 1, type: "llm.request" });
  assert.equal((await store.listEpisodic("t1", "u1")).length, 1); // 仅本任务
  assert.equal((await store.listEpisodic("t1", "u2")).length, 0); // 跨用户
});

test("Procedural 须 evaluator 验证；按用户隔离", async () => {
  const store = new InMemoryMemoryStore();
  await store.addProcedural({ userId: "u1", name: "skill", steps: [], verifiedBy: "evaluator" });
  assert.equal((await store.listProcedural("u1")).length, 1);
  assert.equal((await store.listProcedural("u2")).length, 0);
  await assert.rejects(() => store.addProcedural({ userId: "u1", name: "x", steps: [], verifiedBy: "human" as "evaluator" }), /evaluator/);
});

test("Context Builder：taskContext 恒注入，不被压缩丢弃", () => {
  const taskContext = taskContextSummary({ id: "t1", title: "收集竞赛", status: "running", usage: { tokens: 100, toolCalls: 2 } }, [{ seq: 1, title: "收集", status: "succeeded" }]);
  const history: ChatMessage[] = [];
  for (let i = 0; i < 40; i++) { history.push(usr(`q${i}`), asst(`h${i}`), tool(`h${i}`, "z".repeat(1500))); }
  const r = buildContext({ layers: { stableInstructions: "SYSTEM", taskContext, userProfile: "专业=计算机", relevantMemory: "", toolSchemas: [] }, history, user: "current", cap: 15000 });
  const systemContent = r.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(systemContent, /当前任务状态/); // 事实来源恒注入
  assert.match(systemContent, /收集竞赛/);
  assert.equal(validatePairing(r.messages).ok, true);
});

test("retrieveRelevantMemory 按 user+task 隔离检索", async () => {
  const store = new InMemoryMemoryStore();
  await store.addEpisodic({ taskId: "t1", userId: "u1", eventSeq: 1, type: "tool.result" });
  await store.addProcedural({ userId: "u1", name: "核验流程", steps: [], verifiedBy: "evaluator" });
  const mem = await retrieveRelevantMemory(store, "u1", "t1");
  assert.match(mem, /tool.result/);
  assert.match(mem, /核验流程/);
  const other = await retrieveRelevantMemory(store, "u2", "t1");
  assert.equal(other, ""); // 跨用户无记忆
});