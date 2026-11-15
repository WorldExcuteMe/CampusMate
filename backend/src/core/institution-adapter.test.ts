import { test } from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry, applyMapping, validateMapping, schemaFingerprint, canTransition, type AdapterMeta, type DeclarativeConfig } from "./institution-adapter.ts";
import { discoverSources, extractHtml, extractPdfText, GenericAdapter } from "./institution-adapters.ts";

const config: DeclarativeConfig = {
  id: "a1", sourceType: "generic",
  fieldMap: { courseName: { source: "name", transform: "trim" }, weekday: { source: "day", transform: "weekday" }, credit: { source: "credit", transform: "number", default: 0 } },
  required: ["courseName", "weekday"],
};

function meta(over: Partial<AdapterMeta> = {}): AdapterMeta {
  return { id: "a1", institutionId: "i1", version: 1, status: "candidate", config, schemaFingerprint: schemaFingerprint(["name", "day", "credit"]), supportedDataTypes: ["schedule"], permissions: ["read"], fixtures: [{ input: [{ name: " 高数 ", day: "一", credit: "3" }], expected: [{ courseName: "高数", weekday: 1, credit: 3 }] }], health: "unknown", errorHistory: [], userConfirmed: false, ...over };
}

test("声明式映射 + transform 白名单（无任意代码）", () => {
  const r = applyMapping(config, [{ name: " 高数 ", day: "一", credit: "3" }]);
  assert.deepEqual(r.records[0], { courseName: "高数", weekday: 1, credit: 3 });
  assert.equal(validateMapping(config, r).ok, true);
  const bad = applyMapping(config, [{ name: "", day: "一" }]);
  assert.equal(validateMapping(config, bad).ok, false);
});

test("生命周期合法/非法转换", () => {
  assert.equal(canTransition("draft", "candidate"), true);
  assert.equal(canTransition("candidate", "validated"), true);
  assert.equal(canTransition("validated", "active"), true);
  assert.equal(canTransition("active", "degraded"), true);
  assert.equal(canTransition("draft", "active"), false); // 跳过验证非法
  assert.equal(canTransition("retired", "active"), false);
});

test("候选验证门控：fixtures 通过→validated", () => {
  const reg = new AdapterRegistry();
  reg.register(meta());
  const r = reg.validateCandidate("a1");
  assert.equal(r.ok, true);
  assert.equal(reg.get("a1")?.status, "validated");
});

test("候选验证失败→保持 candidate + 错误历史", () => {
  const reg = new AdapterRegistry();
  reg.register(meta({ fixtures: [{ input: [{ name: "x", day: "一" }], expected: [{ courseName: "不匹配" }] }] }));
  const r = reg.validateCandidate("a1");
  assert.equal(r.ok, false);
  assert.equal(reg.get("a1")?.status, "candidate");
  assert.ok(reg.get("a1")!.errorHistory.length >= 1);
});

test("激活门控：须 validated + 用户确认（禁止未验证激活）", () => {
  const reg = new AdapterRegistry();
  reg.register(meta()); // candidate
  assert.throws(() => reg.activate("a1", true), /先通过候选验证/);
  reg.validateCandidate("a1"); // → validated
  assert.throws(() => reg.activate("a1", false), /用户确认/);
  const active = reg.activate("a1", true);
  assert.equal(active.status, "active");
});

test("Schema fingerprint 变更 → degraded", () => {
  const reg = new AdapterRegistry();
  reg.register(meta());
  reg.validateCandidate("a1"); reg.activate("a1", true);
  const degraded = reg.checkSchema("a1", ["name", "day", "credit", "newField"]);
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.health, "degraded");
});

test("环境发现：从已知 URL 枚举源 + 格式识别", async () => {
  const sources = await discoverSources({ institutionId: "i1", name: "某大学", knownUrls: ["https://x.edu/schedule.ics", "https://x.edu/notice.html"] });
  assert.equal(sources.length, 2);
  assert.equal(sources[0].format, "ics");
  assert.equal(sources[1].format, "html");
});

test("HTML 声明式提取（无 eval）", () => {
  const html = "<html><body>课程：高等数学 时间：周一 08:00</body></html>";
  const r = extractHtml(html, [{ field: "courseName", pattern: "课程：([^\\s]+)" }, { field: "day", pattern: "周([一二三四五六日])" }]);
  assert.equal(r[0].courseName, "高等数学");
  assert.equal(r[0].day, "一");
});

test("PDF 文本声明式提取", () => {
  const r = extractPdfText("课程：线性代数 学分：2", [{ field: "courseName", pattern: "课程：([^\\s]+)" }, { field: "credit", pattern: "学分：(\\d+)" }]);
  assert.equal(r[0].courseName, "线性代数");
  assert.equal(r[0].credit, "2");
});

test("GenericAdapter normalize/validate（配置驱动）", async () => {
  const a = new GenericAdapter(config);
  const norm = await a.normalize({ records: [{ name: "高数", day: "一", credit: "3" }] });
  assert.equal((await a.validate(norm)).ok, true);
});