// 端到端冒烟：真实 API + Worker + DeepSeek 在进程内跑通一个任务（证明服务端 Agent 可用）。
// 读取 web/.env.local 的服务端密钥（仅本地，不打印密钥）。运行：node scripts/smoke.ts
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/api/server.ts";
import { InMemoryStore } from "../src/runtime/store.ts";
import { Worker } from "../src/runtime/worker.ts";
import { DeepSeekTransport } from "../src/core/llm.ts";
import { CLOUD_TOOLS, executeCloudTool } from "../src/core/cloud-tools.ts";
import { signJwt } from "../src/api/jwt.ts";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const txt = fs.readFileSync(new URL("../../web/.env.local", import.meta.url), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch { /* ignore */ }
  return env;
}

const env = loadEnv();
if (!env.LLM_API_KEY) { console.error("SMOKE_FAIL: web/.env.local 无 LLM_API_KEY"); process.exit(1); }

const secret = "smoke-secret";
const store = new InMemoryStore();
const server = createApiServer({ store, jwtSecret: secret, storeKind: "memory" });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const transport = new DeepSeekTransport({ apiKey: env.LLM_API_KEY, baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL });
const worker = new Worker({
  store, transport, tools: CLOUD_TOOLS,
  buildSystem: (t) => `你是 CampusMate 校园机会管家。任务：${t.title}。简洁中文回答。`,
  executeTool: async (_t, name, args) => executeCloudTool(name, args),
  workerId: "smoke",
});

const token = signJwt({ sub: "smoke-user", exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
const t0 = Date.now();
const create = await fetch(`${base}/v1/tasks`, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ title: "用一句话说明你是什么助手" }),
});
const { taskId } = (await create.json()) as { taskId: string };
console.log("submitted:", taskId, "http", create.status);

await worker.tick(); // 认领并执行（真实模型调用）

const task = await store.getTask(taskId);
const events = await store.listEvents(taskId);
console.log("status:", task?.status);
console.log("reply:", task?.result?.summary);
console.log("usage:", JSON.stringify(task?.usage));
console.log("events:", events.map((e) => e.type).join(" → "));
console.log("ms:", Date.now() - t0);
console.log(task?.status === "succeeded" ? "SMOKE_PASS" : "SMOKE_FAIL");

server.close();
process.exit(task?.status === "succeeded" ? 0 : 1);