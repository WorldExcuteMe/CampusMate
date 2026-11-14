import { expect, test, type Page } from "@playwright/test";

async function seedExpiryFixture(page: Page) {
  await page.clock.install({ time: new Date("2026-11-14T15:00:00Z") }); // Beijing 23:00
  await page.route("**/api/providers", route => route.fulfill({ json: { providers: [], mutable: false } }));
  await page.goto("/app/radar");
  await expect(page.getByRole("heading", { name: "Opportunity Radar" })).toBeVisible();
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("campusmate.demo.v1")!);
    const base = state.opportunities[0];
    state.opportunities = [
      { ...base, id: "expiry-today", title: "今日截止机会", deadline: "2026-11-14", status: "active" },
      { ...base, id: "expiry-old", title: "去年报名记录", deadline: "2025-11-25", status: "active" },
      { ...base, id: "expiry-unknown", title: "日期未知机会", deadline: null, status: "active" },
      { ...base, id: "expiry-archived", title: "已归档记录", deadline: "2027-01-01", status: "archived" },
    ];
    const task = state.tasks[0];
    state.tasks = [
      { ...task, id: "overdue", title: "逾期班会任务", dueAt: "2026-11-13", status: "todo", kind: "daily" },
      { ...task, id: "today", title: "今日截止任务", dueAt: "2026-11-14", status: "todo", kind: "daily" },
      { ...task, id: "seven", title: "七天后任务", dueAt: "2026-11-21", status: "in_progress" },
      { ...task, id: "eight", title: "八天后任务", dueAt: "2026-11-22", status: "todo" },
      { ...task, id: "done", title: "已完成旧任务", dueAt: "2025-11-25", status: "done", kind: "daily" },
      { ...task, id: "cancelled", title: "已取消旧任务", dueAt: "2025-11-25", status: "cancelled" },
    ];
    localStorage.setItem("campusmate.demo.v1", JSON.stringify(state));
  });
  await page.reload();
}

test("机会时效：默认不展示过期项、分类保留历史、窄屏不溢出、跨天自动更新", async ({ page }) => {
  await seedExpiryFixture(page);
  await expect(page.getByRole("link", { name: /今日截止机会/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /去年报名记录|日期未知机会|已归档记录/ })).toHaveCount(0);
  await page.getByRole("button", { name: "已过期（1）", exact: true }).click();
  await page.getByRole("link", { name: /去年报名记录/ }).click();
  await expect(page.getByRole("button", { name: "创建参与计划" })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("历史记录");
  await page.goto("/app/radar");
  await page.getByRole("button", { name: "待核实日期（1）", exact: true }).click();
  await expect(page.getByRole("link", { name: /日期未知机会/ })).toBeVisible();
  await page.getByRole("button", { name: "已归档（1）", exact: true }).click();
  await expect(page.getByRole("link", { name: /已归档记录/ })).toBeVisible();
  await page.getByRole("button", { name: "全部（4）", exact: true }).click();
  await page.getByPlaceholder("搜索机会…").fill("去年");
  await expect(page.getByRole("link", { name: /去年报名记录/ })).toBeVisible();
  await page.getByPlaceholder("搜索机会…").clear();
  await page.setViewportSize({ width: 390, height: 740 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("expiry-radar-mobile.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "有效（1）", exact: true }).click();
  await page.clock.fastForward(3_600_100);
  await expect(page.getByRole("button", { name: "有效（0）", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /今日截止机会/ })).toHaveCount(0);
  await page.getByRole("button", { name: "已过期（2）", exact: true }).click();
  await expect(page.getByRole("link", { name: /今日截止机会/ })).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("campusmate.demo.v1")!));
  expect(stored.opportunities).toHaveLength(4);
  expect(stored.opportunities[0]).toMatchObject({ deadline: "2026-11-14", status: "active" });
  expect(stored.opportunities[1].deadline).toBe("2025-11-25");
  expect(stored.tasks).toHaveLength(6);
});

test("待办时效：逾期不算临近截止、跳转筛选、日常完成与撤销仍能持久化", async ({ page }) => {
  await seedExpiryFixture(page);
  await page.goto("/app");
  await expect(page.getByRole("link", { name: "2 7 天内截止", exact: true })).toBeVisible();
  const overdueStat = page.getByRole("link", { name: "1 已逾期待处理", exact: true });
  await expect(overdueStat).toBeVisible();
  await expect(page.getByRole("heading", { name: "逾期待办（1）" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("expiry-dashboard.png"), fullPage: true, animations: "disabled" });
  await overdueStat.click();
  await expect(page).toHaveURL(/view=overdue/);
  await expect(page.getByText("逾期班会任务", { exact: true })).toBeVisible();
  await expect(page.getByText("已完成旧任务", { exact: true })).toBeVisible(); // growth archive, not overdue list
  await expect(page.getByText("今日截止任务", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "7 天内截止", exact: true }).click();
  await expect(page.getByRole("tab", { name: "7 天内截止", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "已逾期（1）", exact: true })).toHaveAttribute("aria-selected", "false");
  await expect(page.getByText("今日截止任务", { exact: true })).toBeVisible();
  await expect(page.getByText("七天后任务", { exact: true })).toBeVisible();
  await expect(page.getByText("逾期班会任务", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 740 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("expiry-growth-mobile.png"), fullPage: true, animations: "disabled" });
  await page.goto("/app/daily");
  const overdueSection = page.getByRole("region", { name: "逾期待处理（1）", exact: true });
  await expect(overdueSection).toBeVisible();
  await overdueSection.getByRole("checkbox", { name: "完成 逾期班会任务", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "撤销完成 逾期班会任务", exact: true })).toBeChecked();
  await page.reload();
  await page.getByRole("checkbox", { name: "撤销完成 逾期班会任务", exact: true }).click();
  await expect(overdueSection.getByRole("checkbox", { name: "完成 逾期班会任务", exact: true })).not.toBeChecked();
  await page.goto("/app");
  await page.getByRole("link", { name: "2 7 天内截止", exact: true }).waitFor();
  await page.clock.fastForward(3_600_100);
  await expect(page.getByRole("link", { name: "2 已逾期待处理", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "2 7 天内截止", exact: true })).toBeVisible(); // 11/21 & 11/22 now within seven days
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("campusmate.demo.v1")!));
  expect(stored.tasks).toHaveLength(6);
  expect(stored.tasks.find((t: { id: string }) => t.id === "overdue").status).toBe("todo");
  expect(stored.tasks.find((t: { id: string }) => t.id === "done").status).toBe("done");
});
