import { act, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ owner: "alice" }));
vi.mock("@/app/auth", () => ({ useAuth: () => ({ session: { user: { id: auth.owner } } }) }));
import { SessionsProvider, useSessions } from "../agent/sessions-context";
import { loadSessions } from "../agent/sessions";
let oldUpdate: () => void;
function Probe() {
  const { active, update } = useSessions();
  if (auth.owner === "alice") oldUpdate = () => update(active.id, (s) => ({ ...s, name: "迟到身份" }));
  return <button onClick={() => update(active.id, (s) => ({ ...s, name: "Alice身份" }))}>{active.name}</button>;
}
beforeEach(() => { auth.owner = "alice"; localStorage.clear(); });
afterEach(cleanup);
it("账号切换重新加载自己的会话，旧异步回调不能覆盖新账号", () => {
  const view = render(<SessionsProvider><Probe /></SessionsProvider>);
  act(() => screen.getByRole("button").click());
  expect(screen.getByRole("button")).toHaveTextContent("Alice身份");
  auth.owner = "bob";
  view.rerender(<SessionsProvider><Probe /></SessionsProvider>);
  expect(screen.getByRole("button")).toHaveTextContent("新会话");
  act(() => oldUpdate());
  expect(loadSessions("bob")[0].name).toBe("新会话");
  expect(loadSessions("alice")[0].name).toBe("Alice身份");
});
