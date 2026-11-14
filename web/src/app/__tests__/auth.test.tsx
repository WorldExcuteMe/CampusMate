import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  listener: null as null | ((event: string, session: Session | null) => void),
  pendingB: null as null | Promise<{ name: string }>,
}));
vi.mock("../config", () => ({ supabaseClient: { auth: {
  getSession: state.getSession,
  onAuthStateChange: (listener: typeof state.listener) => {
    state.listener = listener;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  },
} } }));
vi.mock("@/lib/data/supabase", () => ({ SupabaseRepository: class {
  mode = "supabase";
  constructor(_db: unknown, private id: string) {}
  getProfile() { return this.id === "user-b" && state.pendingB ? state.pendingB : Promise.resolve({ name: this.id }); }
} }));
vi.mock("@/lib/data/demo", () => ({ DemoRepository: class {
  mode = "demo";
  getProfile() { return Promise.resolve({ name: "demo" }); }
} }));
import { AuthProvider, useRepository } from "../auth";

let clients: QueryClient[] = [];
function Probe() {
  const repo = useRepository();
  const client = useQueryClient();
  if (!clients.includes(client)) clients.push(client);
  const query = useQuery({ queryKey: ["profile"], queryFn: () => repo.getProfile() });
  return <div data-testid="profile">{query.data?.name ?? "loading"}</div>;
}
const session = (id: string) => ({ user: { id }, access_token: `token-${id}` } as Session);
beforeEach(() => {
  clients = [];
  state.pendingB = null;
  state.listener = null;
  state.getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
});
afterEach(cleanup);

describe("session-scoped repositories and query caches", () => {
  it("restores the real repository before mounting child queries, including StrictMode", async () => {
    state.getSession.mockResolvedValue({ data: { session: session("user-a") }, error: null });
    render(<StrictMode><AuthProvider><Probe /></AuthProvider></StrictMode>);
    await waitFor(() => expect(screen.getByTestId("profile")).toHaveTextContent("user-a"));
    expect(screen.getByTestId("profile")).not.toHaveTextContent("demo");
  });
  it("does not carry cached data across A → B → Demo; refresh keeps the same principal cache", async () => {
    state.getSession.mockResolvedValue({ data: { session: session("user-a") }, error: null });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("profile")).toHaveTextContent("user-a"));
    const cacheA = clients.at(-1)!;
    cacheA.setQueryData(["private-marker"], "A-only");
    let finishB!: (p: { name: string }) => void;
    state.pendingB = new Promise((resolve) => { finishB = resolve; });
    act(() => state.listener!("SIGNED_IN", session("user-b")));
    expect(screen.getByTestId("profile")).toHaveTextContent("loading");
    const cacheB = clients.at(-1)!;
    expect(cacheB).not.toBe(cacheA);
    expect(cacheB.getQueryData(["private-marker"])).toBeUndefined();
    expect(cacheA.getQueryData(["private-marker"])).toBeUndefined();
    await act(async () => { finishB({ name: "user-b" }); });
    await waitFor(() => expect(screen.getByTestId("profile")).toHaveTextContent("user-b"));
    act(() => state.listener!("TOKEN_REFRESHED", session("user-b")));
    expect(clients.at(-1)).toBe(cacheB);
    act(() => state.listener!("SIGNED_OUT", null));
    await waitFor(() => expect(screen.getByTestId("profile")).toHaveTextContent("demo"));
    expect(clients.at(-1)).not.toBe(cacheB);
  });
  it("does not let a stale initial session read overwrite a newer auth event", async () => {
    let finish!: (value: unknown) => void;
    state.getSession.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<AuthProvider><Probe /></AuthProvider>);
    act(() => state.listener!("SIGNED_IN", session("user-b")));
    await waitFor(() => expect(screen.getByTestId("profile")).toHaveTextContent("user-b"));
    await act(async () => { finish({ data: { session: session("user-a") }, error: null }); });
    expect(screen.getByTestId("profile")).toHaveTextContent("user-b");
  });
});
