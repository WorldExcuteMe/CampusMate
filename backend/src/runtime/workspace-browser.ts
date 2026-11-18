import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { text, tool, type WorkspaceTool } from "./workspace-tools.ts";

export function campusBrowser(storage: string, configuredOrigins: string[]) {
  const origins = new Set(configuredOrigins.map((entry) => {
    const url = new URL(entry);
    if (url.protocol !== "https:" || url.username || url.password || url.origin !== entry.replace(/\/$/, "")) throw new Error("高校站点须填写 HTTPS 来源，如 https://portal.example.edu");
    return url.origin;
  }));
  let browser: BrowserContext | undefined;
  const matches = (url: string) => origins.has(new URL(url).origin);
  const entry: WorkspaceTool = {
    definition: tool("campus_browser", "打开或读取已配置的高校网站。打开后用户可在独立浏览器登录；读取时返回当前目标页面的可见文字。", {
      action: { ...text, enum: ["open", "read"] }, url: text,
    }, ["action", "url"]),
    capability: "host.browser",
    privateSource: true,
    approval: (args) => `${args.action === "open" ? "打开" : "读取"}本地高校浏览器页面 ${args.url}`,
    execute: async ({ action, url: target }) => {
      const url = new URL(String(target));
      if (url.protocol !== "https:" || url.username || url.password || !matches(url.href)) throw new Error("该页面不在此工作区配置的高校站点范围内");
      if (action === "open") {
        if (!browser) {
          browser = await chromium.launchPersistentContext(path.join(storage, "browser"), { headless: false, acceptDownloads: false, timeout: 12000 });
          browser.on("close", () => { browser = undefined; });
        }
        const page = browser.pages().at(-1) ?? await browser.newPage();
        await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 15000 });
        return { url: page.url(), title: await page.title(), loginInterruption: !matches(page.url()) };
      }
      const page = browser?.pages().find((tab) => tab.url() === url.href);
      if (!page) throw new Error("目标页面尚未打开，或登录后已跳转。请使用实际页面地址");
      const body = await page.locator("body").innerText({ timeout: 5000 });
      if (page.url() !== url.href) throw new Error("页面在读取期间跳转，请重新核对实际地址");
      return { url: url.href, title: await page.title(), content: body.slice(0, 14000), truncated: body.length > 14000 };
    },
  };
  return { tools: origins.size ? [entry] : [], close: async () => { if (browser) await browser.close(); } };
}
