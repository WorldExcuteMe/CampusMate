import { expect, test } from "@playwright/test";

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release: () => release() };
}

test("聊天进度显示真实模型/工具阶段和计时，切换会话不串状态，完成后消失", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => { localStorage.setItem("campusmate.onboarded", "true"); });
  await page.route("**/api/providers", route => route.fulfill({ json: { providers: [{ id: "fixture", name: "测试模型", model: "fixture", hasKey: true }] } }));
  const first = gate(), tool = gate(), final = gate();
  let requests = 0;
  await page.route("**/api/llm", async route => {
    const initial = requests++ === 0;
    await (initial ? first.wait : final.wait);
    await route.fulfill({ json: { model: "fixture", choices: [{ message: initial
      ? { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "web_fetch", arguments: '{"url":"https://example.org/"}' } }] }
      : { content: "进度测试已完成。" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } });
  });
  await page.route("**/api/web/fetch", async route => { await tool.wait; await route.fulfill({ json: { status: 200, text: "fixture only" } }); });
  await page.goto("/app/agent");
  await expect(page.getByRole("combobox")).toContainText("测试模型");
  await page.getByPlaceholder(/输入消息/).fill("查看 https://example.org/，测试执行进度");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const card = page.getByTestId("agent-activity");
  await expect(card.getByRole("status")).toContainText("正在等待模型回复");
  await expect(page.getByRole("button", { name: "处理中", exact: true })).toBeDisabled();
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: "新会话", exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "查看处理进度", exact: true }).click();
  await expect(card).toBeVisible();
  await page.clock.fastForward(22_000);
  await expect(card.getByLabel("已等待时间")).toContainText("22 秒");
  await expect(card.getByRole("note")).toContainText("暂未收到新结果");
  await card.screenshot({ path: "test-results/agent-progress-model.png", animations: "disabled" });
  first.release();
  await expect(card.getByRole("status")).toContainText("正在读取网页");
  await expect(card.getByRole("status")).toContainText("第 1 / 1 个工具");
  await expect(card.getByRole("note")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 700 });
  const box = (await card.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await card.screenshot({ path: "test-results/agent-progress-tool-mobile.png", animations: "disabled" });
  tool.release();
  await expect(card.getByRole("status")).toContainText("已返回 1 次工具结果");
  final.release();
  await expect(page.getByText("进度测试已完成。", { exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
});

test("失败后清掉等待标记，不再无限转圈", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("campusmate.onboarded", "true"); });
  await page.route("**/api/providers", route => route.fulfill({ json: { providers: [{ id: "fixture", name: "测试模型", model: "fixture", hasKey: true }] } }));
  const response = gate();
  await page.route("**/api/llm", async route => { await response.wait; await route.fulfill({ status: 400, json: { error: "invalid_tools" } }); });
  await page.goto("/app/agent");
  await expect(page.getByRole("combobox")).toContainText("测试模型");
  await page.getByPlaceholder(/输入消息/).fill("hi");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("agent-activity")).toBeVisible();
  response.release();
  await expect(page.getByText("执行失败 · 可重发重试", { exact: true })).toBeVisible();
  await expect(page.getByTestId("agent-activity")).toHaveCount(0);
});
