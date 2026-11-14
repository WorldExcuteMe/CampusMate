import { expect, test } from "@playwright/test";
import { createHandler } from "../functions/handler";

const provider = { id: "fixture", name: "测试模型", baseUrl: "https://model.example/v1", protocol: "openai", model: "fixture-chat", apiKey: "fixture-only" };

for (const reject of [false, true]) {
  test(reject ? "Agent 请求校验错误不冒充连接失败或 Mock" : "Demo 业务数据也能通过共享代理调用真实模型协议", async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem("campusmate.onboarded", "true"); });
    const toolCounts: number[] = [];
    const handler = createHandler({
      authorize: async () => "fixture-user", providers: () => [provider],
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        toolCounts.push(body.tools.length);
        return Response.json({ choices: [{ message: { content: "测试协议回复已收到" } }], model: provider.model, usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    await page.route("**/api/providers", async route => {
      const response = await handler(new Request(route.request().url()));
      await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
    });
    await page.route("**/api/llm", async route => {
      const req = route.request();
      const response = reject ? Response.json({ error: "invalid_tools" }, { status: 400 })
        : await handler(new Request(req.url(), { method: "POST", headers: { "Content-Type": "application/json" }, body: req.postData()! }));
      await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
    });
    await page.goto("/app/agent");
    await expect(page.getByRole("combobox")).toContainText("测试模型");
    await page.getByPlaceholder(/输入消息/).fill("hi");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    if (reject) {
      await expect(page.getByText(/模型请求被拒绝（invalid_tools）/)).toBeVisible();
      await expect(page.getByText("执行失败 · 可重发重试", { exact: true })).toBeVisible();
      await expect(page.getByText(/模型连接失败/)).toHaveCount(0);
    } else {
      await expect(page.getByText("测试协议回复已收到", { exact: true })).toBeVisible();
      expect(toolCounts).toEqual([17]);
    }
    await expect(page.getByText("MOCK · 规则提取", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/模型配置独立，AI\s*结果按实际来源标识/)).toBeVisible();
  });
}
