import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop.ts";
import type { ToolDef } from "./types.ts";
import { VISION_CLAIMS } from "./vision-verification.ts";
import { generationPolicy } from "./generation-policy.ts";
const tools: ToolDef[] = ["web_search", "web_fetch"].map(name => ({ type: "function", function: { name, description: name, parameters: { type: "object" } } }));
const claims = { title: "2026全国大学生人工智能创新大赛", organizer: "中国人工智能学会", deadline: "2026年5月15日", url: "www.caai-contest.cn", watermarks: ["AI生成"], description: "赛事海报", uncertain: [] };

test("short image verification extracts once, researches text, then guards unsupported verdicts", async () => {
  let calls = 0; const stages: (string | undefined)[] = [], images: boolean[] = []; const deltas: string[] = [];
  const result = await runAgentLoop({ system: "s", user: "核实一下这个图片是真实的吗", images: ["data:image/png;base64,AAAA"], deps: {
    tools, budget: { tokens: 20000, toolCalls: 10, wallMs: 60000, costUsd: 1 }, reasoning: "high", hooks: { onEvent: (type, payload) => { if (type === "llm.delta") deltas.push(String(payload.text)); } },
    transport: { chat: async opts => {
      calls++; stages.push(opts.stage); images.push(JSON.stringify(opts.messages).includes("data:image"));
      if (calls === 3) opts.onDelta?.("这是虚假赛事，AI水印足以证明。");
      return { content: calls === 1 ? JSON.stringify(claims) : calls === 3 ? "这是虚假赛事，AI水印足以证明。" : "", toolCalls: calls === 2 ? [{ id: "s", type: "function", function: { name: "web_search", arguments: '{"query":"全国大学生人工智能创新大赛"}' } }] : [], model: "contract", usage: { input: 1, output: 1 } };
    } },
    executeTool: async name => name === "web_search" ? '{"results":[{"title":"中国人工智能学会","url":"https://organizer.example/"}]}' : '{"status":200,"url":"https://organizer.example/","text":"中国人工智能学会。中国人工智能数字创新大赛。"}',
  } });
  assert.equal(result.stopReason, "completed"); assert.deepEqual(stages, ["extract", undefined, "summary"]);
  assert.deepEqual(images, [true, false, false]); assert.equal(result.usage.tokens, 6);
  assert.match(result.reply, /尚未核实/); assert(result.reply.includes(claims.title)); assert(result.reply.includes("https://organizer.example/"));
  assert(!result.reply.includes("这是虚假赛事")); assert(!result.messages.some(m => JSON.stringify(m).includes("data:image")));
  assert(!deltas.join("").includes("这是虚假赛事")); assert(deltas.join("").includes("尚未核实"));
});

test("a matching notice can be summarized but extracted text stays untrusted data", async () => {
  let calls = 0;
  const result = await runAgentLoop({ system: "s", user: "核实图片里的比赛", images: ["data:image/png;base64,AAAA"], deps: {
    tools, budget: { tokens: 20000, toolCalls: 10, wallMs: 60000, costUsd: 1 },
    transport: { chat: async opts => { calls++; if (calls > 1) assert(opts.messages.some(m => m.role === "user" && String(m.content).includes("图片声明")));
      return { content: calls === 1 ? JSON.stringify(claims) : calls === 3 ? "找到2026年同名赛事通知，仍应核对更新：https://organizer.example/notice" : "", toolCalls: calls === 2 ? [{ id: "f", type: "function" as const, function: { name: "web_fetch", arguments: '{"url":"https://organizer.example/notice"}' } }] : [], model: "contract", usage: { input: 1, output: 1 } }; } },
    executeTool: async () => JSON.stringify({ status: 200, url: "https://organizer.example/notice", text: "2026全国大学生人工智能创新大赛官方参赛通知，主办：中国人工智能学会。" }),
  } });
  assert.equal(result.stopReason, "completed"); assert.match(result.reply, /找到2026年同名赛事通知/);
});

test("bad extraction stops before research, rather than inventing image claims", async () => {
  let calls = 0, executed = 0;
  const result = await runAgentLoop({ system: "s", user: "核实图片真假", images: ["data:image/png;base64,AAAA"], deps: { tools, budget: { tokens: 20000, toolCalls: 5, wallMs: 60000, costUsd: 1 },
    transport: { chat: async () => { calls++; return { content: "looks fake", toolCalls: [], model: "contract", usage: { input: 1, output: 1 } }; } }, executeTool: async () => { executed++; return "{}"; } } });
  assert.equal(result.error, "vision_extraction_incomplete"); assert.equal(calls, 1); assert.equal(executed, 0);
});

test("saved text extraction resumes without reloading image or rerunning extraction", async () => {
  let calls = 0;
  const observation = { role: "user" as const, content: VISION_CLAIMS + JSON.stringify(claims) };
  const result = await runAgentLoop({ system: "s", user: "核实图片真假", resumeMessages: [{ role: "system", content: "s" }, { role: "user", content: "核实图片真假" }, observation], resumeTranscript: [observation], deps: {
    tools, budget: { tokens: 20000, toolCalls: 5, wallMs: 60000, costUsd: 1 },
    transport: { chat: async opts => { assert.notEqual(opts.stage, "extract"); assert(!JSON.stringify(opts.messages).includes("data:image")); calls++; return { content: "图片已被证明虚假。", toolCalls: [], model: "contract", usage: { input: 1, output: 1 } }; } }, executeTool: async () => "{}" } });
  assert.equal(calls, 1); assert.match(result.reply, /尚未核实/); assert(!result.reply.includes("已被证明虚假"));
});

test("light extraction does not lock research to low reasoning", () => {
  const caps = { reasoning: "chat_template_kwargs" };
  assert.equal(generationPolicy(caps, "high", "extract", 1536).effective, "off");
  assert.equal(generationPolicy(caps, "high", "verify", 4096).effective, "on");
});

test("offline image follow-up reuses this session's saved claims with no tools and light summary", async () => {
  let calls = 0;
  const result = await runAgentLoop({ system: "s", user: "只根据刚才图片列出标题，不要联网；AI标记能单独证明赛事是假的？", history: [{ role: "user", content: VISION_CLAIMS + JSON.stringify(claims) }], deps: {
    tools, reasoning: "auto", budget: { tokens: 20000, toolCalls: 5, wallMs: 60000, costUsd: 1 },
    transport: { chat: async opts => { calls++; assert.equal(opts.stage, "summary"); assert.deepEqual(opts.tools, []); assert(JSON.stringify(opts.messages).includes(claims.title)); return { content: "图片声称：2026全国大学生人工智能创新大赛。AI标记不能单独证明赛事虚假。", toolCalls: [], model: "contract", usage: { input: 1, output: 1 } }; } },
    executeTool: async () => { assert.fail("offline question must not execute tools"); },
  } });
  assert.equal(calls, 1); assert.match(result.reply, /^图片声称/); assert(!result.reply.includes("本轮未取得可用网页正文"));
});

test("image verification reads a discovered organizer page before a bounded summary", async () => {
  let calls = 0, reads = 0;
  const result = await runAgentLoop({ system: "s", user: "核实这个图片真实吗", images: ["data:image/png;base64,AAAA"], deps: { tools, reasoning: "high", budget: { tokens: 20000, toolCalls: 5, wallMs: 60000, costUsd: 1 },
    transport: { chat: async opts => { calls++; if (calls === 3) { assert.equal(opts.stage, "summary"); assert.deepEqual(opts.tools, []); } return { content: calls === 1 ? JSON.stringify(claims) : calls === 3 ? "未核实" : "", toolCalls: calls === 2 ? [{ id: "s", type: "function", function: { name: "web_search", arguments: '{"query":"中国人工智能学会"}' } }] : [], model: "contract", usage: { input: 1, output: 1 } }; } },
    executeTool: async name => { if (name === "web_fetch") { reads++; return '{"status":200,"url":"https://organizer.example/","text":"中国人工智能学会首页，未包含图中活动。"}'; } return '{"results":[{"title":"中国人工智能学会","url":"https://organizer.example/"}]}'; },
  } });
  assert.equal(calls, 3); assert.equal(reads, 1); assert.match(result.reply, /尚未核实/); assert(result.reply.includes("https://organizer.example/"));
});

test("automatic short chat reserves a bounded output while explicit high retains its budget", async () => {
  for (const reasoning of ["auto", "high"]) {
    let limit = 0;
    await runAgentLoop({ system: "s", user: "我的专业未知吗？只简短回答", deps: { tools: [], stage: "simple", reasoning, budget: { tokens: 20000, toolCalls: 5, wallMs: 60000, costUsd: 1 },
      transport: { chat: async opts => { limit = opts.maxOutputTokens!; return { content: "未知", toolCalls: [], model: "contract", usage: { input: 1, output: 1 } }; } }, executeTool: async () => "{}" } });
    assert(reasoning === "auto" ? limit <= 2048 : limit >= 4096);
  }
});
