import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("campusmate.onboarded", "true");
    localStorage.setItem("campusmate.sessions.v1.demo", JSON.stringify([
      { id: "hint-fixture", name: "悬停提示测试", mode: "auto", createdAt: new Date().toISOString(), messages: [], tokens: 0 },
      { id: "keep-fixture", name: "保留会话", mode: "auto", createdAt: new Date().toISOString(), messages: [], tokens: 0 },
    ]));
  });
  await page.goto("/app/agent");
});

test("归档/删除图标悬停显示说明，悬停不触发动作，删除仍需二次确认", async ({ page }) => {
  const row = page.locator('[data-session-id="hint-fixture"]');
  await row.hover();
  await row.getByRole("button", { name: "归档会话", exact: true }).hover();
  await expect(page.getByRole("tooltip", { name: "归档会话 · 保留聊天记录", exact: true })).toBeVisible();
  await row.getByRole("button", { name: "删除会话", exact: true }).hover();
  await expect(page.getByRole("tooltip", { name: "删除会话 · 需再次确认", exact: true })).toBeVisible();
  const snapshot = await page.evaluate(() => JSON.parse(localStorage.getItem("campusmate.sessions.v1.demo")!));
  expect(snapshot).toHaveLength(2);
  expect(snapshot[0].archived).toBeUndefined();
  await page.screenshot({ path: "test-results/session-delete-tooltip.png", animations: "disabled" });
  await row.getByRole("button", { name: "删除会话", exact: true }).click();
  await expect(row.getByRole("button", { name: "确认删除", exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("campusmate.sessions.v1.demo")!).length)).toBe(2);
  await row.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('[data-session-id="keep-fixture"]')).toBeVisible();
});

test("归档可恢复，键盘聚焦同样可见提示，Esc 能关闭提示", async ({ page }) => {
  const row = page.locator('[data-session-id="hint-fixture"]');
  const archive = row.getByRole("button", { name: "归档会话", exact: true });
  await archive.focus();
  await expect(archive).toHaveCSS("opacity", "1");
  await expect(page.getByRole("tooltip", { name: "归档会话 · 保留聊天记录", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await archive.click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "归档（1）", exact: true }).click();
  const restore = row.getByRole("button", { name: "恢复会话", exact: true });
  await restore.focus();
  await expect(page.getByRole("tooltip", { name: "恢复会话 · 移回活跃列表", exact: true })).toBeVisible();
  await restore.click();
  await page.getByRole("button", { name: "返回活跃会话", exact: true }).click();
  await expect(row).toBeVisible();
  const snapshot = await page.evaluate(() => JSON.parse(localStorage.getItem("campusmate.sessions.v1.demo")!));
  expect(snapshot).toHaveLength(2);
  expect(snapshot[0].archived).toBe(false);
});
