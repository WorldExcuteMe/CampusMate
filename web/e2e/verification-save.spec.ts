import { expect, test } from "@playwright/test";

test("核验保存失败不显示成功，停止模型续写，重试成功后才新增报告", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("campusmate.onboarded", "true"));
  await page.route("**/api/providers", route => route.fulfill({ json: { providers: [{ id: "fixture", name: "核验测试模型", model: "fixture", hasKey: true }], mutable: false } }));
  let modelRequests = 0;
  await page.route("**/api/llm", route => {
    modelRequests++;
    const body = route.request().postDataJSON();
    const message = body.messages.at(-1).role === "tool"
      ? { content: "核验报告已保存成功。" }
      : { content: null, tool_calls: [{ id: `verify-${modelRequests}`, type: "function", function: { name: "verify_opportunity", arguments: JSON.stringify({ opportunityId: "fixture-opportunity", status: "UNVERIFIED", summary: "fixture", evidence: [{ sourceUrl: "https://example.org/fixture", excerpt: "fixture", supports: "deadline", confidence: 0.5 }] }) } }] };
    return route.fulfill({ json: { model: "fixture", choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } } });
  });
  await page.goto("/app/agent");
  await expect(page.getByRole("combobox")).toContainText("核验测试模型");
  // Isolated persistence fault injection; real SQL rollback/RLS is tested separately against Docker.
  const before = await page.evaluate(() => {
    // Intercept the actual persistence boundary, not a second copy of a Vite HMR module.
    const original = Storage.prototype.setItem;
    (window as any).restoreVerificationWriter = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) {
      if (key === "campusmate.demo.v1") {
        const previous = JSON.parse(this.getItem(key) ?? '{"reports":[]}');
        if (JSON.parse(value).reports.length > previous.reports.length) {
          throw new Error("fixture evidence persistence rejected");
        }
      }
      return original.call(this, key, value);
    };
    return JSON.parse(localStorage.getItem("campusmate.demo.v1")!).reports.length;
  });
  await page.getByPlaceholder(/输入消息/).fill("核验这个机会并保存报告");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("assistant-markdown").last()).toContainText("核验报告保存失败");
  await expect(page.getByText("执行失败 · 可重发重试", { exact: true })).toBeVisible();
  await expect(page.getByText("核验报告已保存成功。", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/写入可信核验/)).toHaveCount(0);
  expect(modelRequests).toBe(1); // No subsequent model can fabricate a save success.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("campusmate.demo.v1")!).reports.length)).toBe(before);
  await page.evaluate(() => (window as any).restoreVerificationWriter());
  await page.getByPlaceholder(/输入消息/).fill("重试保存核验报告");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("assistant-markdown").last()).toContainText("核验报告已保存成功。");
  expect(modelRequests).toBe(3);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("campusmate.demo.v1")!).reports.length)).toBe(before + 1);
});
