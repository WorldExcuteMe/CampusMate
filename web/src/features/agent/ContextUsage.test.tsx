import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ContextUsage } from "./ContextUsage";

describe("ContextUsage 上下文上限编辑", () => {
  it("可原地修改上限并恢复默认", () => {
    const onChange = vi.fn();
    render(<ContextUsage used={1000} cap={262_144} tokens={1200} model="Qwen3.8-27B" capEditable onCapChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "修改上下文上限" }));
    const input = screen.getByLabelText("上下文上限（tokens）");
    fireEvent.change(input, { target: { value: "1000000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存上下文上限" }));
    expect(onChange).toHaveBeenCalledWith(1_000_000);

    fireEvent.click(screen.getByRole("button", { name: "修改上下文上限" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复模型默认上限" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("上限未知时仍显示窗口未知且可编辑", () => {
    render(<ContextUsage used={null} cap={null} capEditable onCapChange={() => undefined} />);
    expect(screen.getByText("窗口未知")).toBeVisible();
    expect(screen.getByRole("button", { name: "修改上下文上限" })).toBeVisible();
  });
});