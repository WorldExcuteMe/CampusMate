import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  runtime: "cloud",
  isCloudRuntime: true,
  supabaseClient: null,
}));
vi.mock("@/lib/data/sites-repository", () => ({ SitesRepository: class {
  mode = "supabase";
  storageScope: string;
  constructor(id: string) { this.storageScope = `cloud:${id}`; }
} }));
vi.mock("@/lib/data/demo", () => ({ DemoRepository: class {
  mode = "demo";
  storageScope = "demo";
} }));
vi.mock("@/lib/data/supabase", () => ({ SupabaseRepository: class {
  mode = "supabase";
} }));

import { AuthProvider, LoginPage, signOut, useAuth, useRepository } from "../auth";

function Probe() {
  const { session } = useAuth();
  const repository = useRepository();
  return <div data-testid="probe">{`${session?.user.id ?? "anon"}:${repository.mode}:${repository.storageScope}`}</div>;
}

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => json({}, 401))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("cloud runtime auth", () => {
  it("探测到平台用户后使用云端仓库", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ user_id: "cloud-user" })));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("cloud-user:supabase:cloud:cloud-user"));
  });

  it("未登录时回退演示仓库并允许进入登录引导", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("anon:demo:demo"));
  });

  it("登录页只展示 Qoder 登录并编码当前路径", () => {
    render(
      <MemoryRouter initialEntries={["/login?next=1"]}>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText("邮箱")).toBeNull();
    const link = screen.getByRole("link", { name: "使用 Qoder 登录" });
    expect(link.getAttribute("href")).toBe(`/__qoder_auth/start?return_path=${encodeURIComponent("/login/?next=1")}`);
  });

  it("平台确认已退出后才返回成功", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/__qoder_auth/logout")) {
        expect(init?.method).toBe("POST");
        return json({}, 200);
      }
      return json({}, 401);
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(signOut()).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("平台会话仍有效时不假装退出成功，并给出 Qoder 账户入口", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).endsWith("/__qoder_auth/logout") ? json({}, 200) : json({ user_id: "still-signed-in" })));
    const result = await signOut();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Qoder");
    expect(result.accountUrl).toBe("https://qoder.com/account");
  });
});
