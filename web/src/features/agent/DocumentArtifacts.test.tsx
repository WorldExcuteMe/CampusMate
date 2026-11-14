import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const api = vi.hoisted(() => ({ get: vi.fn(), download: vi.fn() }));
vi.mock("@/lib/agent/api-client", () => ({ getArtifact: api.get, downloadArtifact: api.download }));
import { DocumentArtifacts } from "./DocumentArtifacts";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("明确打开文档才读取，React以正文展示HTML字符，下载调用真实授权客户端", async () => {
  api.get.mockResolvedValue({ artifact: { id: "artifact", kind: "document", revision: 2, sha256: "abc", inline: { schemaVersion: 1, title: "项目策划书", kind: "proposal", sources: [], blocks: [{ type: "paragraph", text: "<script>alert(1)</script> 这是正文", claimType: "unverified" }] } }, availableFormats: ["md"] });
  api.download.mockResolvedValue({ blob: new Blob(["content"]), filename: "项目策划书.md" });
  URL.createObjectURL = vi.fn(() => "blob:document"); URL.revokeObjectURL = vi.fn(); vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<QueryClientProvider client={new QueryClient()}><DocumentArtifacts ids={["artifact"]} owner="alice" partial /></QueryClientProvider>);
  expect(api.get).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: /查看未完成草稿/ }));
  expect(await screen.findByText("<script>alert(1)</script> 这是正文")).toBeVisible(); expect(document.querySelector("script")).toBeNull();
  expect(screen.queryByRole("button", { name: /DOCX/ })).toBeNull(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "下载 MD" })); });
  await vi.waitFor(() => expect(api.download).toHaveBeenCalledWith("artifact", "md"));
});
