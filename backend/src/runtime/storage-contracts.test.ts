import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OWNER, OTHER, contextFor, storageFixture } from "./storage-test-fixture.ts";

for (const mode of ["memory", "postgres"] as const) {
  // Break caught: missing consumer stores, duplicate retries, or a session owner check omitted by an adapter.
  test(`${mode}：用户消息和稍后 assistant 消息独立保存，重试不复制历史`, async (t) => {
    const context = mode === "postgres" ? (await storageFixture(t)).first : contextFor();
    assert.ok(context.sessionStore, "AppContext 必须提供 sessionStore");
    const sessions = context.sessionStore;
    const session = await sessions.create({ userId: OWNER, title: "个人竞赛规划" });
    assert.match(session.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const task = await context.store.createTask({ userId: OWNER, sessionId: session.id, title: "竞赛推荐" });
    const userInput = { userId: OWNER, sessionId: session.id, turnId: "turn-1", messageKey: "turn-1:user", taskId: task.id, role: "user" as const, content: "我是计算机专业大二学生" };
    const first = await sessions.appendMessage(userInput);
    assert.equal((await sessions.appendMessage(userInput)).id, first.id);
    await assert.rejects(() => sessions.appendMessage({ ...userInput, content: "不应改写既有身份" }), /conflict|冲突/i);
    assert.deepEqual((await sessions.listMessages(OWNER, session.id)).map((m) => m.content), ["我是计算机专业大二学生"]);
    const assistant = { ...userInput, messageKey: "turn-1:assistant", role: "assistant" as const, content: "已了解你的专业和年级" };
    await sessions.appendMessage(assistant);
    await sessions.appendMessage(assistant);
    assert.deepEqual((await sessions.listMessages(OWNER, session.id)).map((m) => [m.seq, m.role]), [[1, "user"], [2, "assistant"]]);
    assert.equal(await sessions.get(OTHER, session.id), null);
    assert.deepEqual(await sessions.listMessages(OTHER, session.id), []);
    await assert.rejects(() => sessions.appendMessage({ ...userInput, userId: OTHER, messageKey: "foreign" }), /owner|forbidden|归属/i);
    await assert.rejects(() => sessions.create({ userId: OWNER, id: "old-local-chat-id" }), /uuid/i);
    await sessions.updateSummary(OWNER, session.id, "计算机专业，大二", 2);
    assert.equal((await sessions.get(OWNER, session.id))?.summaryThroughSeq, 2);
    assert.equal((await sessions.listMessages(OWNER, session.id)).length, 2, "摘要不能覆盖消息事实来源");
    await assert.rejects(() => sessions.updateSummary(OWNER, session.id, "超前摘要", 3), /sequence|序/i);
    const foreignTask = await context.store.createTask({ userId: OTHER, title: "他人任务" });
    await assert.rejects(() => sessions.appendMessage({ ...userInput, taskId: foreignTask.id, messageKey: "foreign-task" }), /owner|forbidden|归属/i);
  });

  test(`${mode}：供应商省略密文保留已有凭据封装，默认配置与 owner 隔离`, async (t) => {
    const context = mode === "postgres" ? (await storageFixture(t)).first : contextFor();
    assert.ok(context.providerStore, "AppContext 必须提供 providerStore");
    const config = { userId: OWNER, providerId: "custom-one", displayName: "自定义模型", protocol: "openai-compatible", baseUrl: "https://api.example/v1", modelId: "example-model", encryptedSecret: { algorithm: "AES-256-GCM" as const, keyVersion: "fixture-v1", nonce: "fixture-nonce", tag: "fixture-tag", ciphertext: "fixture-ciphertext" }, isDefault: true };
    await context.providerStore.upsert(config);
    const { encryptedSecret: _secret, ...metadata } = config;
    await context.providerStore.upsert({ ...metadata, displayName: "更改显示名" });
    assert.equal((await context.providerStore.get(OWNER, config.providerId))?.encryptedSecret?.ciphertext, "fixture-ciphertext");
    assert.equal(await context.providerStore.get(OTHER, config.providerId), null);
    await context.providerStore.upsert({ ...metadata, providerId: "custom-two", isDefault: true });
    assert.equal((await context.providerStore.list(OWNER)).filter((p) => p.isDefault).length, 1);
    await context.providerStore.upsert({ ...metadata, removeSecret: true });
    assert.equal((await context.providerStore.get(OWNER, config.providerId))?.encryptedSecret, undefined);
  });

  test(`${mode}：Artifact 版本重试幂等、内容哈希正确且不能写入他人任务`, async (t) => {
    const context = mode === "postgres" ? (await storageFixture(t)).first : contextFor();
    assert.ok(context.artifactStore, "AppContext 必须提供 artifactStore");
    const task = await context.store.createTask({ userId: OWNER, title: "项目策划书" });
    const input = { userId: OWNER, taskId: task.id, documentId: "33333333-3333-4333-8333-333333333333", revision: 1, kind: "document", inline: { content: "中文策划书" }, sha256: createHash("sha256").update('{"content":"中文策划书"}').digest("hex") };
    const artifact = await context.artifactStore.create(input);
    assert.equal((await context.artifactStore.create(input)).id, artifact.id);
    assert.equal((await context.artifactStore.listByTask(OWNER, task.id)).length, 1);
    assert.equal(await context.artifactStore.get(OTHER, artifact.id), null);
    await assert.rejects(() => context.artifactStore!.create({ ...input, userId: OTHER, revision: 2 }), /owner|forbidden|归属/i);
    await assert.rejects(() => context.artifactStore!.create({ ...input, inline: { content: "changed" } }), /hash|哈希|revision|版本/i);
  });

  test(`${mode}：Artifact 拒绝未经可信读取验证的 path-only 内容声明`, async (t) => {
    const context = mode === "postgres" ? (await storageFixture(t)).first : contextFor();
    const task = await context.store.createTask({ userId: OWNER, title: "文件声明" });
    await assert.rejects(() => context.artifactStore!.create({ userId: OWNER, taskId: task.id, kind: "document", storagePath: "C:/untrusted/claim.pdf", sha256: "0".repeat(64) }), /content|trusted|内容/i);
  });

  test(`${mode}：Artifact 多层JSON键序与jsonb回读不改变哈希或幂等版本`, async (t) => {
    const context = mode === "postgres" ? (await storageFixture(t)).first : contextFor();
    const task = await context.store.createTask({ userId: OWNER, title: "稳定文档JSON" });
    const input = { userId: OWNER, taskId: task.id, documentId: "55555555-5555-4555-8555-555555555555", revision: 1, kind: "document", inline: { zeta: 1, alpha: { z: 2, a: 3 } }, sha256: createHash("sha256").update('{"alpha":{"a":3,"z":2},"zeta":1}').digest("hex") };
    const artifact = await context.artifactStore!.create(input);
    const read = await context.artifactStore!.get(OWNER, artifact.id);
    assert.ok(read);
    assert.equal((await context.artifactStore!.create({ ...input, inline: read.inline })).id, artifact.id);
    assert.equal(read.sha256, input.sha256);
  });

  test(`${mode}：JSON自有键参与Artifact哈希、往返及同版本冲突检查`, async (t) => {
    const context = mode === "postgres" ? (await storageFixture(t)).first : contextFor();
    const task = await context.store.createTask({ userId: OWNER, title: "完整JSON正文" });
    const original = '{"__proto__":{"x":1},"content":"A"}';
    const changed = '{"__proto__":{"x":2},"content":"A"}';
    const input = { userId: OWNER, taskId: task.id, documentId: "66666666-6666-4666-8666-666666666666", revision: 1, kind: "document", inline: JSON.parse(original), sha256: createHash("sha256").update(original).digest("hex") };
    const artifact = await context.artifactStore!.create(input);
    const read = await context.artifactStore!.get(OWNER, artifact.id);
    assert.ok(read);
    assert.equal(Object.hasOwn(read.inline as object, "__proto__"), true);
    assert.deepEqual((read.inline as Record<string, unknown>)["__proto__"], { x: 1 });
    assert.equal((await context.artifactStore!.create({ ...input, inline: read.inline })).id, artifact.id);
    await assert.rejects(() => context.artifactStore!.create({ ...input, inline: JSON.parse(changed), sha256: createHash("sha256").update(changed).digest("hex") }), /revision|版本|conflict/i);
  });

  test(`${mode}：证据不能引用其他owner或其他任务的Artifact`, async (t) => {
    const context = mode === "postgres" ? (await storageFixture(t)).first : contextFor();
    const ownTask = await context.store.createTask({ userId: OWNER, title: "产物所属任务" });
    const otherTask = await context.store.createTask({ userId: OTHER, title: "另一用户任务" });
    const sameOwnerTask = await context.store.createTask({ userId: OWNER, title: "同用户另一任务" });
    const artifact = await context.artifactStore!.create({ userId: OWNER, taskId: ownTask.id, kind: "document", inline: { content: "证据材料" }, sha256: createHash("sha256").update('{"content":"证据材料"}').digest("hex") });
    const evidence = { sourceUrl: "https://school.example/source", excerpt: "校园创新赛事通知", supports: "比赛时间", artifactId: artifact.id };
    await assert.rejects(() => context.evidenceStore.add({ ...evidence, userId: OTHER, taskId: otherTask.id }), /artifact|owner|forbidden|产物|归属/i);
    await assert.rejects(() => context.evidenceStore.add({ ...evidence, userId: OWNER, taskId: sameOwnerTask.id }), /artifact|task|forbidden|产物|任务/i);
    assert.equal((await context.evidenceStore.add({ ...evidence, userId: OWNER, taskId: ownTask.id })).artifactId, artifact.id);
  });

  test(`${mode}：导入任务不允许他人接管或把作业移至其他学期`, async (t) => {
    const context = mode === "postgres" ? (await storageFixture(t)).first : contextFor();
    const termInput = { userId: OWNER, institutionId: "example", name: "秋季", startDate: "2026-09-01", endDate: "2027-01-15", totalWeeks: 20, timezone: "Asia/Shanghai" };
    const term = await context.personalContext.createTerm(termInput);
    const another = await context.personalContext.createTerm({ ...termInput, name: "另一个学期" });
    const job = await context.personalContext.createImportJob({ userId: OWNER, termId: term.id, format: "csv", status: "previewed", sourceName: "课表", previewCount: 2, errorCount: 0, version: 1, createdAt: 1 });
    assert.equal(await context.personalContext.updateImportJob(job.id, { userId: OTHER, status: "confirmed" }), null);
    await assert.rejects(() => context.personalContext.updateImportJob(job.id, { userId: OWNER, termId: another.id }), /term|学期|forbidden/i);
    assert.equal((await context.personalContext.updateImportJob(job.id, { userId: OWNER, status: "confirmed" }))?.status, "confirmed");
  });
}
