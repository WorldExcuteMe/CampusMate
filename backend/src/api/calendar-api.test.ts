import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import * as XLSX from "xlsx";
import { createApiServer } from "./server.ts";
import { InMemoryStore } from "../runtime/store.ts";
import { ValidatedMemoryPersonalContextStore } from "../runtime/memory-storage.ts";
import { signJwt } from "./jwt.ts";
const CSV = 'courseName,weekday,startTime,endTime,startWeek,endWeek,weekPattern,classroom\n"设计,实践",1,08:00,09:40,1,16,every,A101';
test("导入API预览不保存、按不可变job确认、重复确认幂等且owner隔离，XLSX可解码", async () => {
  const pc = new ValidatedMemoryPersonalContextStore();
  const server = createApiServer({ store: new InMemoryStore(), personalContext: pc, jwtSecret: "calendar-fixture" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (uid: string) => signJwt({ sub: uid, exp: Math.floor(Date.now() / 1000) + 60 }, "calendar-fixture");
  const request = async (path: string, body?: unknown, user = "alice") => {
    const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token(user)}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const { body: { term } } = await request("/v1/terms", { institutionId: "学校A", name: "秋季", startDate: "2026-09-07", endDate: "2027-01-24", totalWeeks: 20, timezone: "Asia/Shanghai" });
    const preview = await request("/v1/schedules/import", { termId: term.id, format: "csv", data: CSV });
    assert.equal(preview.status, 200); assert.ok(preview.body.jobId); assert.equal(preview.body.preview.schedules[0].courseName, "设计,实践");
    assert.equal((await pc.listSchedules("alice", term.id)).length, 0);
    const stolen = await request("/v1/schedules/import", { confirm: true, jobId: preview.body.jobId }, "bob"); assert.equal(stolen.status, 404);
    const saved = await request("/v1/schedules/import", { confirm: true, jobId: preview.body.jobId, data: "伪造更改" }); assert.equal(saved.body.saved, 1);
    await request("/v1/schedules/import", { confirm: true, jobId: preview.body.jobId });
    assert.equal((await pc.listSchedules("alice", term.id)).length, 1);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ courseName: "英语", weekday: 3, startTime: "10:00", endTime: "11:40", startWeek: 1, endWeek: 16 }]), "课程");
    const data = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
    const xlsx = await request("/v1/schedules/import", { termId: term.id, format: "xlsx", encoding: "base64", data });
    assert.equal(xlsx.body.preview.schedules.length, 1); assert.equal(xlsx.body.preview.errors.length, 0);
    const bad = await request("/v1/schedules/import", { termId: term.id, format: "csv", data: CSV.replace("08:00", "25:70") });
    assert.ok(bad.body.preview.errors.length); assert.equal((await request("/v1/schedules/import", { confirm: true, jobId: bad.body.jobId })).status, 422);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});
