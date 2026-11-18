import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop.ts";
import type { LlmTransport } from "./llm.ts";
import type { ChatResult, ToolDef } from "./types.ts";
import { DEFAULT_BUDGET } from "./types.ts";
import { LlmTransportError } from "./errors.ts";
import { RESERVE_OUTPUT } from "./context.ts";

test("search-only runtimes report real search leads for both native and JSON protocols", async () => {
  const search: ToolDef[] = [{ type: "function", function: { name: "web_search", description: "search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }];
  for (const native of [true, false]) {
    let requests = 0, executed = 0;
    const transport = { chat: async (): Promise<ChatResult> => { requests++; return { content: requests === 1 ? native ? "" : '{"tool":"web_search","args":{"query":"竞赛"}}' : "根据真实搜索结果找到候选链接，日期仍需核对。", toolCalls: requests === 1 && native ? [tc("web_search", {query:"竞赛"})] : [], model: "contract", usage: {input:1,output:1} }; } };
    const result = await runAgentLoop({ system: "s", user: "收集竞赛信息", deps: { transport, tools: search, budget: DEFAULT_BUDGET, executeTool: async () => { executed++; return JSON.stringify({results:[{title:"竞赛线索",url:"https://example.org/notice"}]}); } } });
    assert.equal(executed,1); assert.equal(result.stopReason,"completed"); assert.ok(result.actions.includes("web_search")); assert.match(result.reply,/搜索/);
  }
});

const tools: ToolDef[] = [{ type: "function", function: { name: "save_to_inbox", description: "x", parameters: { type: "object", properties: {} } } }];
const tc = (name: string, args: Record<string, unknown>, id = "c1") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
test("insufficient input budget pauses before any text or vision model request", async () => {
  for (const images of [undefined, ["data:image/png;base64,AAAA"]]) {
    let calls = 0; const events: string[] = [];
    const result = await runAgentLoop({ system: "校园通知助手", user: images ? "核验这张通知图片" : "给一个方案", ...(images ? {images} : {}), deps: { tools, budget: { tokens: 1, toolCalls: 5, wallMs: 60000, costUsd: 1 }, transport: {estimateInputTokens:()=>2300,chat:async()=>{calls++;return {content:"不该花费这些tokens",toolCalls:[],model:"contract",usage:{input:2300,output:1}};}}, executeTool:async()=>"{}", hooks: {onEvent:type=>{events.push(type);}} } });
    assert.equal(calls,0); assert.equal(result.usage.tokens,0); assert.equal(result.budgetExceeded,true); assert.equal(events.filter(type=>type==="llm.request").length,0);
  }
});

class FakeTransport implements LlmTransport {
  i = 0;
  script: Partial<ChatResult>[];
  constructor(script: Partial<ChatResult>[]) { this.script = script; }
  async chat(): Promise<ChatResult> {
    const m = this.script[Math.min(this.i, this.script.length - 1)]; this.i++;
    return { content: m.content ?? "", toolCalls: m.toolCalls ?? [], usage: m.usage ?? { input: 1, output: 1 }, model: m.model ?? "fake" };
  }
}

test("工具调用→落库→最终答复（mock=false，usage 累计）", async () => {
  const transport = new FakeTransport([
    { toolCalls: [tc("save_to_inbox", { title: "竞赛" })] },
    { content: "已写入。" },
  ]);
  const r = await runAgentLoop({
    system: "s", user: "写inbox",
    deps: { transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => JSON.stringify({ ok: true, title: "竞赛" }) },
  });
  assert.equal(r.reply, "已写入。");
  assert.equal(r.mock, false);
  assert.ok(r.actions.includes("save_to_inbox"));
  assert.equal(r.usage.toolCalls, 1);
  assert.ok(r.usage.tokens > 0);
});

test("工具失败 error 观测回传，循环不中断（mock=false）", async () => {
  const transport = new FakeTransport([
    { toolCalls: [tc("save_to_inbox", { title: "x" })] },
    { content: "写入失败，已知悉。" },
  ]);
  const r = await runAgentLoop({
    system: "s", user: "写inbox",
    deps: { transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => JSON.stringify({ error: "工具 save_to_inbox 执行失败：duplicate key | code: 23505" }) },
  });
  assert.equal(r.mock, false);
  assert.match(r.reply, /写入失败/);
  assert.ok(!r.reply.includes("[object Object]"));
});

test("预算硬停：toolCalls=1 → 本地说明，不能追加模型请求", async () => {
  const transport = new FakeTransport([
    { toolCalls: [tc("save_to_inbox", { title: "a" })] },
    { content: "最终总结。" },
  ]);
  const r = await runAgentLoop({
    system: "s", user: "x",
    deps: { transport, tools, budget: { ...DEFAULT_BUDGET, toolCalls: 1 }, executeTool: async () => JSON.stringify({ ok: true }) },
  });
  assert.equal(r.budgetExceeded, true);
  assert.equal(r.usage.toolCalls, 1);
  assert.match(r.reply, /预算超限停止/);
  assert.equal(transport.i, 1);
});

test("真实传输失败 → mock=true，可读，无 [object Object]", async () => {
  const transport: LlmTransport = { async chat() { throw new LlmTransportError("上游模型错误 HTTP 401: invalid api key"); } };
  const r = await runAgentLoop({ system: "s", user: "x", deps: { transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => "{}" } });
  assert.equal(r.mock, true);
  assert.equal(r.model, "unreachable");
  assert.match(r.reply, /invalid api key/);
  assert.ok(!r.reply.includes("[object Object]"));
});

test("模型错误事件保留分类与实际 HTTP 状态", async () => {
  const events: Record<string, unknown>[] = [];
  const transport: LlmTransport = {
    async chat() { throw new LlmTransportError("服务提供方限流", { reason: "rate_limit", status: 429 }); },
  };
  const result = await runAgentLoop({
    system: "s", user: "x",
    deps: {
      transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => "{}",
      hooks: { onEvent(type, payload) { if (type === "llm.response") events.push(payload); } },
    },
  });
  assert.equal(result.error, "llm_rate_limit");
  assert.equal(events.length, 1);
  assert.equal(events[0].errorCategory, "rate_limit");
  assert.equal(events[0].httpStatus, 429);
});

test("进入编程执行后保留完整工具输出额度，首次请求沿用短额度", async () => {
  const workspaceTools: ToolDef[] = ["workspace_run", "workspace_write"].map(name => ({
    type: "function", function: { name, description: name, parameters: { type: "object" } },
  }));
  const limits: number[] = [];
  const transport: LlmTransport = {
    async chat(config) {
      limits.push(config.maxOutputTokens ?? 0);
      return {
        content: limits.length === 1 ? "" : "文件已生成。",
        toolCalls: limits.length === 1 ? [tc("workspace_run", {})] : [],
        usage: { input: 10, output: 10 }, model: "fixture",
      };
    },
  };
  await runAgentLoop({
    system: "s", user: "Build a project using the local workspace.",
    deps: { transport, tools: workspaceTools, budget: DEFAULT_BUDGET, executeTool: async () => '{"exitCode":0}' },
  });
  assert.deepEqual(limits, [2048, RESERVE_OUTPUT]);
});

test("JSON 工具回退（无原生 tool_calls 的模型）", async () => {
  const transport = new FakeTransport([
    { content: '{"tool":"save_to_inbox","args":{"title":"x"}}' },
    { content: "完成。" },
  ]);
  const r = await runAgentLoop({ system: "s", user: "x", deps: { transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => JSON.stringify({ ok: true }) } });
  assert.equal(r.reply, "完成。");
  assert.equal(r.usage.toolCalls, 1);
});

test("事件与检查点钩子被调用", async () => {
  const events: string[] = [];
  let checkpoints = 0;
  const transport = new FakeTransport([{ toolCalls: [tc("save_to_inbox", {})] }, { content: "ok" }]);
  await runAgentLoop({
    system: "s", user: "x",
    deps: { transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => JSON.stringify({ ok: true }), hooks: { onEvent: (t) => { events.push(t); }, onCheckpoint: () => { checkpoints++; } } },
  });
  assert.ok(events.includes("tool.called"));
  assert.ok(events.includes("checkpoint.written"));
  assert.ok(checkpoints >= 1);
});

test("a research file request receives one transition after four discovery-only rounds", async () => {
  const names = ["web_search", "web_fetch", "document_create", "document_export"];
  const researchTools: ToolDef[] = names.map(name => ({ type: "function", function: { name, description: name, parameters: {} } }));
  const markers: number[] = [];
  let round = 0;
  const result = await runAgentLoop({
    system: "fixture",
    user: "Research urban transit and write a Word document.",
    deps: {
      tools: researchTools, budget: DEFAULT_BUDGET,
      transport: { chat: async ({ messages, tools }) => {
        markers.push(messages.filter(m => m.role === "system" && String(m.content).includes("【研究交付进度】")).length);
        assert.ok(tools?.some(tool => tool.function.name === "document_export"));
        const i = ++round;
        return { content: i > 5 ? "资料不足，未交付。" : "", toolCalls: i > 5 ? [] : [tc("web_search", { query: "transit " + i }, "search-" + i)], usage: { input: 1, output: 1 }, model: "fixture" };
      } },
      executeTool: async () => '{"results":[]}',
    },
  });
  assert.deepEqual(markers, [0, 0, 0, 0, 1, 1]);
  assert.match(result.reply, /未交付/);
});

test("input and output verification is scoped to a workspace with both coding tools", async () => {
  for (const writable of [false, true]) {
    let instruction: string | undefined;
    const names = writable ? ["workspace_run", "workspace_write"] : ["workspace_run"];
    await runAgentLoop({
      system: "fixture",
      user: "处理本地结构化数据",
      deps: {
        tools: names.map(name => ({ type: "function", function: { name, description: name, parameters: {} } })),
        budget: DEFAULT_BUDGET,
        transport: { chat: async ({ messages }) => {
          instruction = messages.find(m => m.role === "system" && String(m.content).includes("【编程验证】"))?.content as string | undefined;
          return { content: "任务说明", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" };
        } },
        executeTool: async () => "{}",
      },
    });
    if (writable) assert.match(instruction ?? "", /完整相对路径.*原文件所在目录/);
    else assert.equal(instruction, undefined);
  }
});

test("failed source reads trigger one research recovery and usable reads suppress it", async () => {
  const names = ["web_search", "web_fetch", "document_create", "document_export"];
  for (const readable of [false, true]) {
    const markers: number[] = [];
    let round = 0;
    await runAgentLoop({
      system: "fixture",
      user: "Research urban transport and write a Word document.",
      deps: {
        tools: names.map(name => ({ type: "function", function: { name, description: name, parameters: {} } })),
        budget: DEFAULT_BUDGET,
        transport: { chat: async ({ messages }) => {
          markers.push(messages.filter(m => m.role === "system" && String(m.content).startsWith("【研究交付进度】")).length);
          const i = ++round;
          const toolCalls = i === 1 ? [tc("web_search", { query: "urban transport" }, "search")]
            : i <= 4 ? [tc("web_fetch", { url: `https://test.example/${i}` }, `fetch-${i}`)] : [];
          return { content: toolCalls.length ? "" : "资料说明", toolCalls, usage: { input: 1, output: 1 }, model: "fixture" };
        } },
        executeTool: async name => name === "web_search" ? '{"results":[]}' : readable
          ? '{"url":"https://test.example/article","readable":true,"status":200,"text":"Article body"}'
          : '{"readable":false,"status":200,"error":"Source unavailable"}',
      },
    });
    assert.deepEqual(markers, [0, 0, 0, 0, readable ? 0 : 1]);
  }
});

test("research follows available source leads before a third search", async () => {
  const names = ["web_search", "web_fetch", "document_create", "document_export"];
  let round = 0;
  let recoveryInstruction = "";
  await runAgentLoop({
    system: "fixture",
    user: "Research municipal housing and write a Word document.",
    deps: {
      tools: names.map(name => ({ type: "function", function: { name, description: name, parameters: {} } })),
      budget: DEFAULT_BUDGET,
      transport: { chat: async ({ messages }) => {
        const i = ++round;
        if (i === 3) recoveryInstruction = String(messages.find(m => m.role === "system" && String(m.content).startsWith("【研究交付进度】"))?.content ?? "");
        return { content: i === 3 ? "暂无已核实资料" : "", toolCalls: i <= 2 ? [tc("web_search", { query: "municipal housing " + i }, "search-" + i)] : [], usage: { input: 1, output: 1 }, model: "fixture" };
      } },
      executeTool: async () => '{"results":[{"url":"https://journal.example/article","title":"Municipal housing"}]}',
    },
  });
  assert.match(recoveryInstruction, /已有候选.*打开/);
});

test("a source-only timetable preview returns the verified receipt without another model request", async () => {
  for (const scenario of ["clean", "parse-error", "additional-task", "denied"] as const) {
    let modelRequests = 0;
    const result = await runAgentLoop({
      system: "fixture",
      user: "从已授权源生成完整课表导入预览，不要正式保存。" + (scenario === "additional-task" ? "另外统计各周的课程数。" : ""),
      deps: {
        tools: [{ type: "function", function: { name: "source_timetable_preview", description: "preview", parameters: {} } }],
        budget: DEFAULT_BUDGET,
        transport: { chat: async () => {
          modelRequests++;
          return { content: "需要进一步处理", toolCalls: modelRequests === 1 ? [tc("source_timetable_preview", { artifactId: "fixture", termId: "term" })] : [], usage: { input: 1, output: 1 }, model: "fixture" };
        } },
        executeTool: async () => scenario === "denied" ? '{"__approval_pending__":true}' : JSON.stringify({ previewUrl: "/calendar?import=job-42", rows: 24, errorCount: scenario === "parse-error" ? 1 : 0, confirmed: false }),
      },
    });
    assert.equal(modelRequests, scenario === "clean" || scenario === "denied" ? 1 : 2, scenario);
    if (scenario === "clean") {
      assert.match(result.reply, /24.*\[打开课表预览\]\(\/calendar\?import=job-42\)/s);
      assert.equal(result.stopReason, "completed");
    }
    if (scenario === "denied") assert.equal(result.paused, true);
  }
});

test("research avoids another network request for the same unreadable URL and allows transient retries", async () => {
  for (const status of [403, 503]) {
    let round = 0;
    let fetches = 0;
    const result = await runAgentLoop({
      system: "fixture",
      user: "Research municipal housing and write a Word document.",
      deps: {
        tools: ["web_search", "web_fetch", "document_create", "document_export"].map(name => ({ type: "function", function: { name, description: name, parameters: {} } })),
        budget: DEFAULT_BUDGET,
        transport: { chat: async () => {
          const i = ++round;
          return { content: i === 3 ? "未核实" : "", toolCalls: i <= 2 ? [tc("web_fetch", { url: "https://example.org/research" }, "fetch-" + i)] : [], usage: { input: 1, output: 1 }, model: "fixture" };
        } },
        executeTool: async () => {
          fetches++;
          return JSON.stringify({ status, readable: false, class: "source_unavailable", error: "No readable content" });
        },
      },
    });
    assert.equal(fetches, status === 403 ? 1 : 2);
    assert.equal(result.usage.toolCalls, 2);
    assert.ok(result.toolErrors);
  }
});

test("document drafts explicitly preserve user-specified section titles", async () => {
  let guidance = "";
  await runAgentLoop({
    system: "fixture",
    user: "写项目完整正文，两章标题为：数据与范围、限制与后续。只写正文。",
    deps: {
      stage: "write",
      tools: [],
      budget: DEFAULT_BUDGET,
      transport: { chat: async ({ messages }) => {
        guidance = messages.filter(m => m.role === "system").map(m => m.content).join(" ");
        return { content: "待交付正文", toolCalls: [], model: "fixture", usage: { input: 1, output: 1 } };
      } },
      executeTool: async () => "{}",
    },
  });
  assert.match(guidance, /原样保留用户指定的标题文字和顺序/);
});
