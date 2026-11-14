import { expect, test } from "@playwright/test";

const reply = `### 有效安排

当前**唯一已核实的有效待办**：实验课，最近一次 **11/21（周六）**。

- 时间：9:30–12:30
- 地点：一教 116

| 项目 | 日期 | 来源 | 状态 |
| --- | --- | --- | --- |
| 计算机组成原理综合实验 | 11/21 | 教务通知 | 待参加 |
| 历史报名 | 2025 年 | 群通知 | 已过期 |

1. 核对时间。
2. 确认后建立提醒。

[来源官网](https://example.org/notice)


![不会自动加载的图片](https://tracker.example/pixel.png)


<script>window.markdownInjection = true</script>`;

test("新旧助手消息均渲染 Markdown，用户原文保留，表格在手机上独立横向滚动", async ({ page }) => {
  const imageRequests: string[] = [];
  page.on("request", req => { if (req.url().includes("tracker.example")) imageRequests.push(req.url()); });
  await page.addInitScript(({ reply }) => {
    localStorage.setItem("campusmate.onboarded", "true");
    localStorage.setItem("campusmate.sessions.v1.demo", JSON.stringify([{ id: "markdown-fixture", name: "排版检查", mode: "auto", createdAt: new Date().toISOString(), tokens: 0,
      messages: [{ role: "user", content: "用户的 **原样文本**" }, { role: "assistant", content: reply }],
    }]));
  }, { reply });
  await page.route("**/api/providers", route => route.fulfill({ json: { providers: [{ id: "fixture", name: "测试模型", model: "fixture", hasKey: true }] } }));
  await page.route("**/api/llm", route => route.fulfill({ json: { model: "fixture", choices: [{ message: { content: "**新回复也正确加粗**" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }));
  await page.goto("/app/agent");
  const message = page.getByTestId("assistant-markdown").first();
  await expect(message.getByRole("heading", { name: "有效安排" })).toBeVisible();
  await expect(message.locator("strong").first()).toHaveText("唯一已核实的有效待办");
  await expect(page.getByText("用户的 **原样文本**", { exact: true })).toBeVisible();
  await expect(message.getByRole("table")).toBeVisible();
  await expect(message.locator("script, iframe, img")).toHaveCount(0);
  await expect(message.getByRole("link", { name: "来源官网" })).toHaveAttribute("rel", "noopener noreferrer nofollow");
  expect(await page.evaluate(() => (window as unknown as { markdownInjection?: boolean }).markdownInjection)).toBeUndefined();
  await message.getByRole("heading").scrollIntoViewIfNeeded();
  await message.screenshot({ path: "test-results/agent-markdown-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 760 });
  const table = message.getByRole("region", { name: "回复中的表格" });
  await expect.poll(() => table.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = (await message.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await message.screenshot({ path: "test-results/agent-markdown-mobile.png", animations: "disabled" });
  expect(imageRequests).toEqual([]);
  await page.getByPlaceholder(/输入消息/).fill("hi");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("assistant-markdown")).toHaveCount(2);
  await expect(page.getByTestId("assistant-markdown").last().locator("strong")).toHaveText("新回复也正确加粗");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("campusmate.sessions.v1.demo")!)[0].messages[1].content);
  expect(stored).toBe(reply);
});
