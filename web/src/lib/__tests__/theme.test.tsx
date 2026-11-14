import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AppearanceProvider } from "../theme";
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
function media() { vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))); }
it("无已保存偏好时采用用户选定的明亮主题", () => { localStorage.clear(); media(); render(<AppearanceProvider><span>页面</span></AppearanceProvider>); expect(document.documentElement.dataset.theme).toBe("light"); });
it("已保存的暗色偏好保持", () => { localStorage.setItem("campusmate.appearance", JSON.stringify({ theme: "dark" })); media(); render(<AppearanceProvider><span>页面</span></AppearanceProvider>); expect(document.documentElement.dataset.theme).toBe("dark"); });
