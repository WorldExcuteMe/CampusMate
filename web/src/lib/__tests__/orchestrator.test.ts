import { describe, expect, it } from "vitest";
import { MockProvider } from "../llm/mock";
import { runInboxPipeline } from "../agent/orchestrator";
import { extractedNoticeSchema } from "../schemas";

describe("runInboxPipeline", () => {
  it("产出通过 Schema 校验的结果与执行记录", async () => {
    const text = "关于举办编程大赛的通知\n报名截止：2026年11月25日\n主办：教务处";
    const res = await runInboxPipeline(
      { rawText: text, sourceUrl: null, sourceType: "text" },
      new MockProvider(),
    );
    expect(extractedNoticeSchema.safeParse(res.extracted).success).toBe(true);
    expect(res.run.status).toBe("succeeded");
    expect(res.run.mock).toBe(true);
    expect(res.classification.priorityScore).toBeGreaterThanOrEqual(0);
  });

  it("空输入抛出校验错误", async () => {
    await expect(
      runInboxPipeline({ rawText: "", sourceUrl: null, sourceType: "text" }, new MockProvider()),
    ).rejects.toBeTruthy();
  });
});