import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { contextFor, OWNER, OTHER } from "../runtime/storage-test-fixture.ts";
import { canonicalArgs, sha256 } from "../runtime/idempotency.ts";
import { createApiServer } from "./server.ts";
import { signJwt } from "./jwt.ts";
import { documentErrors, documentMarkdown } from "../../../shared/document.ts";
test("文档授权预览/MD下载内容与哈希对应，他人不可读，原始HTML不执行", async () => {
  const ctx = contextFor(), task = await ctx.store.createTask({ userId: OWNER, title: "文档" });
  const inline = { schemaVersion: 1 as const, title: "中文策划书", kind: "document" as const, sources: [], blocks: [{ type: "paragraph" as const, text: '<script>alert("x")</script> 中文 & 测试', claimType: "unverified" as const }] };
  assert.equal(documentErrors(inline).length, 0); assert.ok(!documentMarkdown(inline).includes("<script>"));
  assert.ok(documentErrors({ ...inline, blocks: [{ type: "image", src: "javascript:alert(1)", alt: "bad" }] }).length);
  const artifact = await ctx.artifactStore.create({ userId: OWNER, taskId: task.id, kind: "document", inline, sha256: sha256(canonicalArgs(inline)) });
  const server = createApiServer({ store: ctx.store, artifactStore: ctx.artifactStore, jwtSecret: "artifact-fixture" }); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = (sub: string) => ({ Authorization: `Bearer ${signJwt({ sub, exp: Math.floor(Date.now() / 1000) + 60 }, "artifact-fixture")}` });
  try {
    const response = await fetch(`${base}/v1/artifacts/${artifact.id}/download?format=md`, { headers: headers(OWNER) }); const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200); assert.equal(bytes.toString("utf8"), documentMarkdown(inline));
    assert.equal(response.headers.get("X-Artifact-Sha256"), artifact.sha256); assert.equal(response.headers.get("X-File-Sha256"), createHash("sha256").update(bytes).digest("hex"));
    assert.equal((await fetch(`${base}/v1/artifacts/${artifact.id}`, { headers: headers(OTHER) })).status, 404);
    assert.equal((await fetch(`${base}/v1/artifacts/${artifact.id}/download`, { headers: headers(OTHER) })).status, 404);
    assert.equal((await fetch(`${base}/v1/tasks/${task.id}/artifacts`, { headers: headers(OTHER) })).status, 404);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});
