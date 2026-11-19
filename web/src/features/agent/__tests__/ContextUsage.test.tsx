import { render, screen } from "@testing-library/react";
import { test, expect } from "vitest";
import { ContextUsage } from "../ContextUsage";

test("上下文占用徽标：百分比、已用/上限、累计、缓存命中与压缩标记", () => {
  render(
    <ContextUsage
      used={100000}
      cap={200000}
      tokens={1234567}
      lastRequest={{ usage: { cacheRead: 99500, inputTotal: 100000, output: 1200, reasoning: 300, costUsd: 0.0012 } }}
      compressed
      model="DeepSeek-V4-Flash"
    />,
  );
  expect(screen.getByLabelText("上下文占用")).toBeTruthy();
  expect(screen.getByText("50%")).toBeTruthy();
  expect(screen.getByText("100.0K/200.0K")).toBeTruthy();
  expect(screen.getByText("1.2M tok")).toBeTruthy();
  expect(screen.getByText("缓存 100%")).toBeTruthy();
  expect(screen.getByText("已压缩")).toBeTruthy();
  const sr = screen.getByText(/窗口输入 100000 \/ 200,000 tok/);
  expect(sr.getAttribute("title")).toContain("DeepSeek-V4-Flash 上限 200,000 tok");
});

test("上下文未知时显示窗口未知而不是虚构百分比", () => {
  render(<ContextUsage used={null} cap={null} tokens={0} />);
  expect(screen.getByText("窗口未知")).toBeTruthy();
  expect(screen.queryByText(/%$/)).toBeNull();
});
