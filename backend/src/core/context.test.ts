import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTurns, validatePairing, trimToBudget, composeContext, estimateTokens, messagesTokens, COMPACTION_SUMMARY_MARKER, truncateTool, TOOL_RESULT_CAP } from "./context.ts";
import { InMemoryMemoryStore } from "./memory.ts";
import { buildContext, retrieveRelevantMemory, taskContextSummary } from "./context-builder.ts";
import type { ChatMessage } from "./types.ts";

const asst = (id: string): ChatMessage => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "t", arguments: "{}" } }] });
const tool = (id: string, content = "result"): ChatMessage => ({ role: "tool", content, tool_call_id: id });
const sys = (c: string): ChatMessage => ({ role: "system", content: c });
const usr = (c: string): ChatMessage => ({ role: "user", content: c });

test("输入估算包含同轮每个工具调用的实际参数", () => {
  const text = "宽".repeat(4000);
  const small = asst("a").tool_calls![0];
  const write = { ...small, function: { name: "workspace_write", arguments: JSON.stringify({ text }) } };
  const single = messagesTokens([{ ...asst("a"), tool_calls: [write] }]);
  assert.ok(single - messagesTokens([asst("a")]) >= estimateTokens(text));
  const second = { ...write, id: "b" };
  const batch = messagesTokens([{ ...asst("a"), tool_calls: [write, second] }]);
  assert.ok(batch - single >= estimateTokens(text));
});

test("大型工具参数超窗时整组移除，保留近期调用和当前目标", () => {
  const oldCall = asst("old");
  oldCall.tool_calls![0].function.arguments = JSON.stringify({ text: "文".repeat(7000) });
  const current = usr("处理最新输入");
  const recent = asst("recent");
  const messages = [sys("rules"), oldCall, tool("old"), current, recent, tool("recent")];
  const result = trimToBudget(messages, 4000, 0, 1000, 3000, current);

  assert.equal(result.compressed, true);
  assert.equal(result.messages.some((message) => message.tool_calls?.some((call) => call.id === "old")), false);
  assert.ok(result.messages.includes(current));
  assert.ok(result.messages.includes(recent));
  assert.equal(validatePairing(result.messages).ok, true);
  assert.ok(messagesTokens(result.messages) <= 3000);
});

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
test("摘要也计入输入预算，压缩不丢当前目标", () => {
  const history: ChatMessage[] = Array.from({ length: 30 }, () => usr("资料正文".repeat(200)));
  const composed = composeContext({ system: "规则", history, user: "推荐竞赛", cap: 6000, reserveOutput: 1000 });
  assert.ok(composed.usedTokens + 1000 <= 6000);
  const current = usr("本轮目标：保留此完整要求");
  const trimmed = trimToBudget([sys("规则"), current, ...history], 6000, 0, 1000, 3000, current);
  assert.ok(trimmed.messages.some((m) => m.content === current.content));
  assert.ok(messagesTokens(trimmed.messages) + 1000 <= 6000);
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
test("压缩摘要结构化保留目标/计划/产物/证据/未完成", () => {
  const filler = (i: number): ChatMessage[] => [
    { role: "assistant", content: "", tool_calls: [{ id: `f${i}`, type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ path: `data/f${i}.txt` }) } }] },
    { role: "tool", content: "x".repeat(500), tool_call_id: `f${i}` },
  ];
  const messages: ChatMessage[] = [
    sys("规则"),
    usr("把成绩表整理成 data/report.docx 并引用官方来源"),
    { role: "assistant", content: "", tool_calls: [{ id: "s1", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "通知" }) } }] },
    { role: "tool", content: JSON.stringify({ results: [{ title: "官方通知", url: "https://example.edu/notice" }] }), tool_call_id: "s1" },
    { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "todo_write", arguments: JSON.stringify({ todos: [{ content: "读取成绩表", status: "completed" }, { content: "生成 report.docx", status: "in_progress" }] }) } }] },
    { role: "tool", content: JSON.stringify({ ok: true }), tool_call_id: "t1" },
    { role: "assistant", content: "", tool_calls: [{ id: "w1", type: "function", function: { name: "workspace_write", arguments: JSON.stringify({ path: "data/report.docx", content: "..." }) } }] },
    { role: "tool", content: JSON.stringify({ ok: true, path: "data/report.docx" }), tool_call_id: "w1" },
    { role: "assistant", content: "", tool_calls: [{ id: "e1", type: "function", function: { name: "workspace_run", arguments: JSON.stringify({ program: "python3", argv: ["-c", "print(1)"] }) } }] },
    { role: "tool", content: JSON.stringify({ error: "web_fetch 失败：读取超时" }), tool_call_id: "e1" },
    ...Array.from({ length: 6 }, (_, i) => filler(i)).flat(),
  ];
  const out = trimToBudget(messages, 900, 0, 120);
  assert.equal(out.compressed, true);
  const summary = out.messages.find((m) => m.role === "system" && String(m.content).startsWith(COMPACTION_SUMMARY_MARKER));
  assert.ok(summary);
  const text = String(summary!.content);
  assert.match(text, /【目标】/);
  assert.match(text, /report\.docx/);
  assert.match(text, /https:\/\/example\.edu\/notice/);
  assert.match(text, /【计划】/);
  assert.match(text, /读取成绩表|生成 report\.docx/);
  assert.match(text, /【未完成\/错误】/);
  assert.equal(validatePairing(out.messages).ok, true);
});
test("工具结果裁剪对 JSON 保持合法 JSON，且提示不引用不存在的工具", () => {
  const big = JSON.stringify({ entries: Array.from({ length: 400 }, (_, i) => ({ id: i, title: `条目${i}-${"x".repeat(20)}` })) });
  assert.ok(big.length > TOOL_RESULT_CAP);
  const jsonTrimmed = truncateTool({ role: "tool", content: big, tool_call_id: "j1" }, TOOL_RESULT_CAP);
  const parsed = JSON.parse(String(jsonTrimmed.content)) as { truncated: boolean; head: string; tail: string; notice: string };
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.head.length > 0);
  assert.ok(parsed.tail.length > 0);
  assert.ok(!parsed.notice.includes("rag_search"));
  assert.match(parsed.notice, /分页|缩小/);
  const plain = "x".repeat(TOOL_RESULT_CAP + 200);
  const plainTrimmed = truncateTool({ role: "tool", content: plain, tool_call_id: "p1" }, TOOL_RESULT_CAP);
  assert.match(String(plainTrimmed.content), /省略/);
  assert.ok(!String(plainTrimmed.content).includes("rag_search"));
});

