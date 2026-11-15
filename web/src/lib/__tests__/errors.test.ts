import { describe, expect, it } from "vitest";
import { errorMessage, isTransportError, LlmTransportError } from "../llm/errors";

describe("errorMessage：任何被抛值都可读，绝不产出 [object Object]", () => {
  it("Error 取 message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  it("字符串原样", () => {
    expect(errorMessage("invalid api key")).toBe("invalid api key");
  });
  it("Supabase PostgrestError 普通对象 → message+code+hint，不是 [object Object]", () => {
    const pg = { message: "duplicate key value violates unique constraint", details: "Key (id)=(x) already exists.", hint: "use upsert", code: "23505" };
    const s = errorMessage(pg);
    expect(s).toContain("duplicate key value");
    expect(s).toContain("23505");
    expect(s).not.toContain("[object Object]");
  });
  it("嵌套 error 对象递归提取 message", () => {
    const s = errorMessage({ error: { message: "maximum context length exceeded", type: "invalid_request_error" } });
    expect(s).toContain("maximum context length exceeded");
    expect(s).not.toContain("[object Object]");
  });
  it("无可读字段的对象 → JSON，不是 [object Object]", () => {
    const s = errorMessage({ foo: 1, bar: [2, 3] });
    expect(s).toContain("foo");
    expect(s).not.toContain("[object Object]");
  });
  it("循环引用对象不抛异常、不产出 [object Object]", () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    const s = errorMessage(o);
    expect(typeof s).toBe("string");
    expect(s).not.toBe("[object Object]");
  });
  it("null / undefined 可读", () => {
    expect(errorMessage(null)).not.toContain("[object Object]");
    expect(errorMessage(undefined)).not.toContain("[object Object]");
  });
  it("超长消息被截断", () => {
    expect(errorMessage("x".repeat(5000)).length).toBeLessThan(600);
  });
});

describe("LlmTransportError 分类", () => {
  it("传输错误可识别", () => {
    expect(isTransportError(new LlmTransportError("down"))).toBe(true);
  });
  it("普通 Error / 对象不是传输错误", () => {
    expect(isTransportError(new Error("db"))).toBe(false);
    expect(isTransportError({ message: "db" })).toBe(false);
  });
});