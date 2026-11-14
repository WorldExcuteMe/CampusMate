import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AssistantMessage } from "../AssistantMessage";

afterEach(cleanup);

it("renders emphasis, headings, lists, GFM tables and code rather than literal Markdown", () => {
  const content = '## 安排\n\n当前**有效待办**：实验课。\n\n1. 核对时间\n2. 建立提醒\n\n| 项目 | 时间 |\n| --- | --- |\n| 实验课 | 11/21 |\n\n```txt\n**代码里的星号要保留**\n```\n\n普通文本第一行\n第二行';
  const { container } = render(<AssistantMessage content={content} />);
  expect(screen.getByRole("heading", { name: "安排", level: 2 })).toBeVisible();
  expect(screen.getByText("有效待办").tagName).toBe("STRONG");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByRole("region", { name: "回复中的表格" })).toContainElement(screen.getByRole("table"));
  expect(screen.getByRole("cell", { name: "11/21" })).toBeVisible();
  expect(container.querySelector("pre code")).toHaveTextContent("**代码里的星号要保留**");
  expect(container.querySelector("pre strong")).toBeNull();
  expect(container.querySelector("p:last-child")?.textContent).toBe("普通文本第一行\n第二行");
});

it("ignores raw HTML and never auto-loads model-provided images", () => {
  const { container } = render(<AssistantMessage content={'<script>alert(1)</script>\n\n<iframe src="https://example.org"></iframe>\n\n<img src=x onerror="alert(2)">\n\n![示意图](https://tracker.example/pixel.png)\n\n正常文字'} />);
  expect(container.querySelector("script, iframe, img")).toBeNull();
  expect(screen.getByText("[图片未自动加载：示意图]")).toBeVisible();
  expect(screen.getByText("正常文字")).toBeVisible();
});

it("only enables safe public links with isolation attributes", () => {
  render(<AssistantMessage content={'[官网](https://example.org/path)\n\n[危险](javascript:alert%281%29) [文件](file:///C:/secret) [相对](../../api/terminal) [本机](http://127.0.0.1:8787/api/ingest/bootstrap) [凭据](https://user:pass@example.org)'} />);
  const link = screen.getByRole("link", { name: "官网" });
  expect(link).toHaveAttribute("href", "https://example.org/path");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByText("危险")).toBeVisible();
});

it("Markdown task lists are display-only, not mutations of application tasks", () => {
  render(<AssistantMessage content={'- [x] 历史标记\n- [ ] 尚未完成'} />);
  const checkboxes = screen.getAllByRole("checkbox");
  expect(checkboxes).toHaveLength(2);
  checkboxes.forEach(checkbox => expect(checkbox).toBeDisabled());
});
