import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildContext } from "../app-context.ts";
import { createApiServer } from "./server.ts";
import { signJwt } from "./jwt.ts";

test("SSE发送轻量快照及事件ID，客户端离开后停止定时读取", { timeout: 8000 }, async (t) => {
  const ctx = buildContext({}); const task = await ctx.store.createTask({ userId: "student", title: "照片任务", images: ["private-image-payload"] });
  let reads = 0; const original = ctx.store.listEvents.bind(ctx.store);
  ctx.store.listEvents = async (...args) => { reads++; return original(...args); };
  const server = createApiServer({ ...ctx, jwtSecret: "stream-test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const token = signJwt({ sub: "student", exp: Math.floor(Date.now() / 1000) + 60 }, "stream-test");
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/tasks/${task.id}/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  const reader = response.body!.getReader(); let text = "";
  while (!text.includes("event: task_status")) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
  assert.match(text, /id: 1/); assert.match(text, /"status":"queued"/);
  assert.ok(!text.includes("private-image-payload"));
  controller.abort(); await reader.cancel().catch(() => {});
  const before = reads;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(reads, before);
});
