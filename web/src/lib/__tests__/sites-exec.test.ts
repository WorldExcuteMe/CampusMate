// @vitest-environment node
// 受控假 DB / 假模型端点：验证档位 clamp、vault 往返、工具轮次上限、
// checkpoint 续跑、终态消息、跨 owner 隔离，以及密钥不落库/不落事件。
import { describe, expect, it } from "vitest";
import {
  advance,
  decrypt,
  decryptProviderKey,
  decodeVaultKey,
  encrypt,
  resolveServerThinking,
  serverProvider,
  SERVER_PROVIDERS,
  VAULT_MASTER_ID,
  VAULT_OWNER,
  vaultAad,
  type ExecDatabase,
  type ExecQuery,
} from "../../../functions/sites-exec";

type Row = Record<string, unknown>;

const TASKS = "campusmate_tasks";
const EVENTS = "campusmate_events";
const MESSAGES = "campusmate_messages";
const SECRETS = "campusmate_secrets";
const INBOX = "campusmate_inbox";
const API_KEY = "sk-radeon-live-SECRET-do-not-leak-8f2c1d";

// 与 sites-v1.test 相同的假 DB 语义：WHERE 匹配后合并 patch，插入按冲突列判重。
function fakeDb() {
  const tables = new Map<string, Row[]>();
  const list = (table: string) => {
    let rows = tables.get(table);
    if (!rows) { rows = []; tables.set(table, rows); }
    return rows;
  };
  const db: ExecDatabase = {
    from(table) {
      let method: "read" | "update" | "insert" = "read";
      let columns = "*", conflict = "id";
      let patch: Row = {}, values: Row = {};
      let filters: [string, unknown][] = [];
      let max: number | undefined;
      const project = (row: Row) => columns === "*" ? structuredClone(row)
        : Object.fromEntries(columns.split(",").map(key => [key.trim(), structuredClone(row[key.trim()])]));
      const execute = async () => {
        const rows = list(table);
        if (method === "update") {
          const target = rows.find(row => filters.every(([key, value]) => row[key] === value));
          if (!target) return { data: [] };
          Object.assign(target, structuredClone(patch));
          return { data: [project(target)] };
        }
        if (method === "insert") {
          if (rows.some(row => row[conflict] === values[conflict])) return { data: [] };
          const row = structuredClone(values);
          rows.push(row);
          return { data: [project(row)] };
        }
        let found = rows.filter(row => filters.every(([key, value]) => row[key] === value));
        if (max !== undefined) found = found.slice(0, max);
        return { data: found.map(project) };
      };
      const query: ExecQuery = {
        select(next) { columns = next; return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        limit(value) { max = value; return query; },
        update(next) { method = "update"; patch = next; return query; },
        insertIfAbsent(next, options) { method = "insert"; values = next; conflict = options.onConflict; return query; },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      return query;
    },
  };
  return {
    db, tables,
    seed(table: string, row: Row) { list(table).push(structuredClone(row)); },
    rows(table: string) { return list(table); },
  };
}

function chatTool(callId: string, title: string): Row {
  return {
    model: "Qwen3.8-27B",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "",
        tool_calls: [{
          id: callId, type: "function",
          function: { name: "save_to_inbox", arguments: JSON.stringify({ title }) },
        }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function chatFinal(content: string): Row {
  return {
    model: "Qwen3.8-27B",
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function fakeFetch(responses: Row[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected_fetch_call");
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");

function taskRow(owner: string, id = "task_exec_1"): Row {
  return {
    id, owner_id: owner, session_id: "sess_1", turn_id: "turn_1",
    title: "整理校园通知", intent: "把通知整理后保存到 Inbox", status: "queued",
    usage: { tokens: 0, toolCalls: 0, wallMs: 0, costUsd: 0 },
    result: null, error: null, seq_counter: 0, cancel_requested: false,
    checkpoint: null, provider_id: "srv-qwen38", runtime: "server-model",
    created_at: 1, updated_at: 1_000,
  };
}

async function seedSecret(
  store: ReturnType<typeof fakeDb>, id: string, ownerId: string, plaintext: string, key: Uint8Array,
): Promise<void> {
  const fields = await encrypt(plaintext, key, vaultAad(id, ownerId, 1));
  store.seed(SECRETS, {
    id, owner_id: ownerId,
    ciphertext: fields.ciphertext, nonce: fields.nonce, tag: fields.tag, key_version: fields.keyVersion,
  });
}

async function fixture(owner = "owner-a", apiKey = API_KEY) {
  const store = fakeDb();
  store.seed(TASKS, taskRow(owner));
  const masterKey = new Uint8Array(32).fill(0x42);
  const wrapKey = new Uint8Array(32).fill(0x24);
  await seedSecret(store, VAULT_MASTER_ID, VAULT_OWNER, bytesToHex(masterKey), wrapKey);
  await seedSecret(store, "radeon", VAULT_OWNER, apiKey, masterKey);
  let clock = 1_000;
  return { store, wrapKey, masterKey, now: () => (clock += 1_000) };
}

const depsOf = (ctx: Awaited<ReturnType<typeof fixture>>, fetchImpl: typeof fetch, reasoning?: "max") => ({
  db: ctx.store.db,
  fetch: fetchImpl,
  wrapKey: ctx.wrapKey,
  now: ctx.now,
  ...(reasoning ? { reasoning } : {}),
});

describe("服务端模型档位 clamp", () => {
  it("Qwen 只支持 low/medium/xhigh：max 收敛为 xhigh，默认也是 xhigh", () => {
    const qwen = serverProvider("srv-qwen38")!;
    expect(qwen.tiers).toEqual(["low", "medium", "xhigh"]);
    expect(resolveServerThinking(qwen, "max", "simple", 2048).params.reasoning_effort).toBe("xhigh");
    expect(resolveServerThinking(qwen, undefined, "simple", 2048).effective).toBe("xhigh");
    // summary 阶段仍按 generationPolicy 降为轻量档。
    expect(resolveServerThinking(qwen, "max", "summary", 1200).effective).toBe("low");
  });

  it("MiMo 的 minimal 显式映射为 low，Moss 保留 minimal", () => {
    const mimo = serverProvider("srv-mimo")!;
    const moss = serverProvider("srv-moss")!;
    expect(resolveServerThinking(mimo, "minimal", "simple", 2048).effective).toBe("low");
    expect(resolveServerThinking(moss, "minimal", "simple", 2048).effective).toBe("minimal");
    expect(SERVER_PROVIDERS.map(provider => provider.id)).toEqual(["srv-qwen38", "srv-mimo", "srv-moss"]);
  });
});

describe("Vault AES-256-GCM", () => {
  it("加解密往返成功，AAD 不匹配时拒绝解密", async () => {
    const key = decodeVaultKey("11".repeat(32));
    const aad = vaultAad("radeon", VAULT_OWNER, 1);
    const fields = await encrypt("sk-round-trip", key, aad);
    expect(await decrypt(fields, key, aad)).toBe("sk-round-trip");
    await expect(decrypt(fields, key, vaultAad("moss", VAULT_OWNER, 1))).rejects.toThrow("vault_decrypt_failed");
  });

  it("服务端 key 可解，用户 BYOK 必须匹配行 owner", async () => {
    const ctx = await fixture();
    expect(await decryptProviderKey(ctx.store.db, "radeon", { wrapKey: ctx.wrapKey })).toBe(API_KEY);

    const byokId = "user:owner-a:srv-qwen38";
    await seedSecret(ctx.store, byokId, "owner-a", "sk-byok-owner-a", ctx.masterKey);
    expect(await decryptProviderKey(ctx.store.db, byokId, { wrapKey: ctx.wrapKey, owner: "owner-a" })).toBe("sk-byok-owner-a");
    await expect(decryptProviderKey(ctx.store.db, byokId, { wrapKey: ctx.wrapKey, owner: "owner-b" }))
      .rejects.toThrow("vault_owner_mismatch");
    await expect(decryptProviderKey(ctx.store.db, byokId, { wrapKey: ctx.wrapKey }))
      .rejects.toThrow("vault_owner_mismatch");
  });
});

describe("工具轮次与 checkpoint", () => {
  it("一次 advance 最多执行 4 轮工具，然后保存 checkpoint 返回 running", async () => {
    const ctx = await fixture();
    const endpoint = fakeFetch([chatTool("call_1", "事项一"), chatTool("call_2", "事项二"), chatTool("call_3", "事项三"), chatTool("call_4", "事项四")]);
    const result = await advance("task_exec_1", "owner-a", depsOf(ctx, endpoint.fetch));

    expect(result.status).toBe("running");
    expect(result.toolRounds).toBe(4);
    expect(endpoint.calls).toHaveLength(4);
    expect(ctx.store.rows(INBOX)).toHaveLength(4);

    const task = ctx.store.rows(TASKS)[0];
    expect(task.status).toBe("running");
    const checkpoint = task.checkpoint as Row;
    expect(checkpoint.toolRounds).toBe(4);
    expect(checkpoint.leaseUntil).toBe(0);
    // 初始 user 消息 + 4 组 assistant/tool 消息。
    expect((checkpoint.messages as unknown[]).length).toBe(9);
    expect(task.usage).toMatchObject({ tokens: 60, toolCalls: 4 });
    expect(ctx.store.rows(EVENTS).filter(event => event.type === "tool.result")).toHaveLength(4);
  });

  it("续跑 checkpoint 收敛为终态：只写一次 assistant 消息，用量不重复累计", async () => {
    const ctx = await fixture();
    const endpoint = fakeFetch([
      chatTool("call_1", "事项一"), chatTool("call_2", "事项二"), chatTool("call_3", "事项三"), chatTool("call_4", "事项四"),
      chatTool("call_5", "事项五"), chatTool("call_6", "事项六"), chatTool("call_7", "事项七"), chatTool("call_8", "事项八"),
      chatFinal("已完成整理，共保存 8 条事项。"),
    ]);

    const first = await advance("task_exec_1", "owner-a", depsOf(ctx, endpoint.fetch));
    expect(first).toMatchObject({ status: "running", toolRounds: 4 });
    expect(first.usage.tokens).toBe(60);
    const second = await advance("task_exec_1", "owner-a", depsOf(ctx, endpoint.fetch));
    expect(second).toMatchObject({ status: "running", toolRounds: 8 });
    expect(second.usage.tokens).toBe(120);
    expect(endpoint.calls).toHaveLength(8);
    expect(ctx.store.rows(INBOX)).toHaveLength(8);

    const final = await advance("task_exec_1", "owner-a", depsOf(ctx, endpoint.fetch));
    expect(final.status).toBe("succeeded");
    expect(final.summary).toBe("已完成整理，共保存 8 条事项。");
    expect(final.toolRounds).toBe(8);
    // 9 次模型调用各 10 input + 5 output；续跑不能把旧用量再叠加一次。
    expect(final.usage).toMatchObject({ inputTokens: 90, outputTokens: 45, tokens: 135, toolCalls: 8 });
    expect(endpoint.calls).toHaveLength(9);
    expect(ctx.store.rows(INBOX)).toHaveLength(8);
    expect(ctx.store.rows(MESSAGES)).toHaveLength(1);

    const task = ctx.store.rows(TASKS)[0];
    expect(task.status).toBe("succeeded");
    expect(task.result).toEqual({ summary: "已完成整理，共保存 8 条事项。", artifactIds: [] });
    expect(task.usage).toMatchObject({ tokens: 135, toolCalls: 8 });

    const events = ctx.store.rows(EVENTS);
    expect(events.map(event => Number(event.seq)).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 36 }, (_, index) => index + 1));
    expect(events.filter(event => event.type === "run.summary")).toHaveLength(1);
  });
});

describe("终态消息", () => {
  it("无工具调用时写入 assistant 消息与 result.summary", async () => {
    const ctx = await fixture();
    const endpoint = fakeFetch([chatFinal("通知已整理，截止时间待确认。")]);
    const result = await advance("task_exec_1", "owner-a", depsOf(ctx, endpoint.fetch));

    expect(result).toMatchObject({ status: "succeeded", summary: "通知已整理，截止时间待确认。" });
    const messages = ctx.store.rows(MESSAGES);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "msg_task_exec_1_assistant", owner_id: "owner-a", session_id: "sess_1",
      task_id: "task_exec_1", role: "assistant", content: "通知已整理，截止时间待确认。",
    });
    const task = ctx.store.rows(TASKS)[0];
    expect(task.result).toEqual({ summary: "通知已整理，截止时间待确认。", artifactIds: [] });
    expect((task.checkpoint as Row).done).toBe(true);
  });
});

describe("跨 owner 隔离", () => {
  it("用其他 owner 推进任务一律 task_not_found，且不产生写入", async () => {
    const ctx = await fixture("owner-a");
    const endpoint = fakeFetch([]);
    await expect(advance("task_exec_1", "owner-b", depsOf(ctx, endpoint.fetch)))
      .rejects.toThrow("task_not_found");
    expect(endpoint.calls).toHaveLength(0);
    expect(ctx.store.rows(INBOX)).toHaveLength(0);
    expect(ctx.store.rows(EVENTS)).toHaveLength(0);
    expect(ctx.store.rows(MESSAGES)).toHaveLength(0);

    const other = await fixture("owner-b");
    await expect(advance("task_exec_1", "owner-a", depsOf(other, fakeFetch([]).fetch)))
      .rejects.toThrow("task_not_found");
    expect(other.store.rows(INBOX)).toHaveLength(0);
    expect(other.store.rows(EVENTS)).toHaveLength(0);
  });
});

describe("密钥边界", () => {
  it("密钥只进 Authorization 请求头，不进入任务、事件、checkpoint、消息或响应", async () => {
    const ctx = await fixture();
    const endpoint = fakeFetch([chatFinal("整理完成。")]);
    const result = await advance("task_exec_1", "owner-a", depsOf(ctx, endpoint.fetch, "max"));

    expect(endpoint.calls).toHaveLength(1);
    const init = endpoint.calls[0].init!;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(init.body)) as Row;
    expect(body).toMatchObject({ model: "Qwen3.8-27B", max_tokens: 2048, reasoning_effort: "xhigh" });

    // 任一表（含 checkpoint / 事件载荷 / assistant 消息）都不得出现明文密钥。
    const snapshot = JSON.stringify({
      tables: [...ctx.store.tables.entries()],
      result,
    });
    expect(snapshot).not.toContain(API_KEY);
    expect(snapshot).not.toContain("Authorization");
  });
});
