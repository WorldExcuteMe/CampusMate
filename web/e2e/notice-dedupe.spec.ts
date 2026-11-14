import { expect, test } from "@playwright/test";

const FORMAL = "关于举办计算机科学与技术学院（大数据学院）2026年模拟面试大赛院级选拔赛的通知(1)";
const MINI = "[QQ小程序]模拟面试大赛";
const PROMO = "模拟面试大赛获奖率很高，可以加综测、积累面试经验等等，大家积极报名参加";
const OTHER = "关于举办第四届全国大学生职业规划大赛校内选拔赛的通知";

test("Agent 合并桥接通知完整归档两条，刷新和重跑不重复改写", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("campusmate.onboarded", "true"); });
  await page.route("**/api/providers", route => route.fulfill({ json: {
    providers: [{ id: "fixture", name: "去重测试模型", model: "fixture", hasKey: true }], mutable: false,
  } }));
  const results: { merged: number; clusters: number }[] = [];
  await page.route("**/api/llm", async route => {
    const body = route.request().postDataJSON();
    const last = body.messages.at(-1);
    let message;
    if (last.role === "tool") {
      const result = JSON.parse(last.content);
      results.push(result);
      message = { content: `本轮合并 ${result.merged} 条重复通知。` };
    } else {
      message = { content: null, tool_calls: [{ id: `merge-${results.length}`, type: "function", function: { name: "merge_inbox", arguments: "{}" } }] };
    }
    await route.fulfill({ json: { model: "fixture", choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } } });
  });
  await page.goto("/app/inbox");
  await expect(page.getByRole("heading", { name: "Campus Inbox", exact: true })).toBeVisible();
  await page.evaluate(({ titles }) => {
    const state = JSON.parse(localStorage.getItem("campusmate.demo.v1")!);
    const base = state.inbox[0];
    // Descending createdAt produces OTHER, FORMAL, PROMO, MINI: bridge is last.
    state.inbox = titles.map((title, index) => ({
      ...base, id: `dedupe-${index}`, title, rawText: title, sourceUrl: null, sourceType: "text",
      status: "pending_review", createdAt: `2026-11-14T10:00:00.00${index}Z`, mergedFrom: [],
      extracted: { ...base.extracted, title, summary: title, deadline: null, sourceUrl: null },
    }));
    localStorage.setItem("campusmate.demo.v1", JSON.stringify(state));
  }, { titles: [MINI, PROMO, FORMAL, OTHER] });
  await page.goto("/app/agent");
  await expect(page.getByRole("combobox")).toContainText("去重测试模型");
  await page.getByPlaceholder(/输入消息/).fill("合并收件箱重复条目");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("assistant-markdown").last()).toContainText("本轮合并 2 条重复通知。");
  expect(results).toEqual([{ merged: 2, clusters: 1 }]);
  const first = await page.evaluate(() => JSON.parse(localStorage.getItem("campusmate.demo.v1")!).inbox);
  expect(first).toHaveLength(4);
  expect(first.filter((item: { status: string }) => item.status === "archived")).toHaveLength(2);
  expect(first.find((item: { id: string }) => item.id === "dedupe-2")).toMatchObject({ status: "pending_review", rawText: FORMAL, mergedFrom: expect.arrayContaining(["dedupe-0", "dedupe-1"]) });
  expect(first.find((item: { id: string }) => item.id === "dedupe-3").status).toBe("pending_review");
  await page.reload();
  await page.getByPlaceholder(/输入消息/).fill("再次合并收件箱重复条目");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("assistant-markdown").last()).toContainText("本轮合并 0 条重复通知。");
  expect(results).toEqual([{ merged: 2, clusters: 1 }, { merged: 0, clusters: 0 }]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("campusmate.demo.v1")!).inbox)).toEqual(first);
});
