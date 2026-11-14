// 回归：真实模型调用不得因工具/DB/记忆异常被误判为「中断（[object Object]）」并降级 Mock。
// 脚本化 LLM 驱动 runChat，stub fetch，不发真实网络。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DemoRepository, resetDemo } from "../data/demo";
import { runChat } from "../agent/chat";
import { clearPlan, clearMemory } from "../agent/memory";
import type { ChatMessage } from "../llm/proxy";
import type { AgentProgress } from "../agent/progress";

type Msg = { content?: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] };
const tc = (name: string, args: Record<string, unknown>, id = "c1") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

// 记录每次 /api/llm 请求体，便于断言工具错误观测被回传给模型。
function router(script: Msg[], bodies: Record<string, unknown>[], llmStatus = 200, llmError?: unknown) {
  let i = 0;
  return vi.fn(async (url: string, opts?: { body?: string }) => {
    const u = String(url);
    const ok = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
    if (u.includes("/api/llm")) {
      const body = JSON.parse(opts?.body ?? "{}");
      bodies.push(body);
      if (llmStatus !== 200) return { ok: false, status: llmStatus, text: async () => JSON.stringify({ error: llmError }) };
      const m = script[Math.min(i, script.length - 1)]; i++;
      return ok({ choices: [{ message: { content: m.content ?? "", tool_calls: m.tool_calls ?? [] } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "deepseek-chat" });
    }
    if (u.includes("/api/env/check")) return ok({ qqKey: true, wechatKey: true });
    return ok({});
  });
}

beforeEach(() => { resetDemo(); clearPlan(); clearMemory(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("runChat 韧性：工具/DB 失败不中断模型、不出现 [object Object]", () => {
  it("progress follows model→actual tool wait→next model; observer errors cannot break execution", async () => {
    const repo = new DemoRepository();
    const profile = await repo.getProfile();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    repo.createTask = async task => { await wait; return task; };
    vi.stubGlobal("fetch", router([{ tool_calls: [tc("create_daily_task", { title: "测试进度" })] }, { content: "已完成。" }], []));
    const progress: AgentProgress[] = [];
    const running = runChat({ message: "创建测试任务", history: [], repository: repo, profile, onProgress: event => { progress.push(event); } });
    await vi.waitFor(() => expect(progress.at(-1)?.phase).toBe("tool"));
    expect(progress.map(p => p.phase)).toEqual(["preparing", "model", "tool"]);
    expect(progress.at(-1)).toMatchObject({ tool: "create_daily_task", toolIndex: 1, toolTotal: 1 });
    release();
    expect((await running).reply).toBe("已完成。");
    expect(progress.at(-1)).toMatchObject({ phase: "model", round: 2, completedTools: 1 });
    vi.stubGlobal("fetch", router([{ content: "正常回复" }], []));
    const out = await runChat({ message: "hi", history: [], repository: repo, profile, onProgress: () => { throw new Error("UI error"); } });
    expect(out.reply).toBe("正常回复");
    expect(out.failed).not.toBe(true);
  });
  it("invalid_tools reports request rejection, not missing key or connection failure", async () => {
    const repo = new DemoRepository();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", router([], bodies, 400, "invalid_tools"));
    const out = await runChat({ message: "hi", history: [], repository: repo, profile: await repo.getProfile(), mode: "auto" });
    expect(out).toMatchObject({ mock: false, failed: true });
    expect(out.reply).toContain("模型请求被拒绝（invalid_tools）");
    expect(out.reply).not.toContain("模型连接失败");
    expect(bodies).toHaveLength(1);
  });
  it("save_to_inbox 写库抛 Supabase 普通对象 → 模型仍在线(mock:false)，错误可读回传，无 [object Object]", async () => {
    const repo = new DemoRepository();
    // 模拟 Supabase PostgrestError：普通对象，非 Error 实例（旧代码 String() → [object Object]）
    repo.createInbox = async () => { throw { message: "duplicate key value violates unique constraint", code: "23505", details: "Key (id)=(x) already exists.", hint: "use upsert" }; };
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", router([
      { tool_calls: [tc("save_to_inbox", { title: "竞赛讲座", summary: "11月16日", category: "activity" })] },
      { content: "这条通知写入失败（重复），我已知悉，不再重复写入。" },
    ], bodies));
    const profile = await repo.getProfile();
    const out = await runChat({ message: "把这条竞赛讲座写进inbox", history: [] as ChatMessage[], repository: repo, profile, mode: "auto" });

    expect(out.mock).toBe(false);
    expect(out.reply).not.toContain("[object Object]");
    expect(out.reply).toContain("写入失败");
    // 第二次 LLM 请求里应包含可读的工具错误观测（含真实 message，而非 [object Object]）
    const second = bodies[1] as { messages: ChatMessage[] };
    const toolMsg = second.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("duplicate key value");
    expect(toolMsg?.content).not.toContain("[object Object]");
  });

  it("真实传输失败(上游错误对象) → 可读中断信息，mock:true，无 [object Object]", async () => {
    const repo = new DemoRepository();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", router([], bodies, 401, { message: "invalid api key", code: "invalid_api_key" }));
    const profile = await repo.getProfile();
    const out = await runChat({ message: "你好", history: [] as ChatMessage[], repository: repo, profile, mode: "auto" });
    expect(out.mock).toBe(true);
    expect(out.model).toBe("unreachable");
    expect(out.reply).toContain("invalid api key");
    expect(out.reply).not.toContain("[object Object]");
  });

  it("localStorage 配额抛错 → 成功答复不被降级为中断", async () => {
    const repo = new DemoRepository();
    const profile = await repo.getProfile(); // 先完成 repo 初始化（其自身也写 localStorage）
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", router([{ content: "你好，有什么可以帮你？" }], bodies));
    // 仅此后 stub setItem：模拟 runChat 结束时 appendMemory 写入配额满
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    const out = await runChat({ message: "你好", history: [] as ChatMessage[], repository: repo, profile, mode: "auto" });
    expect(out.mock).toBe(false);
    expect(out.reply).toContain("你好");
    expect(out.reply).not.toContain("[object Object]");
  });
});
