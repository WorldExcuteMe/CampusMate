import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { GraduationCap, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runtime, supabaseClient } from "./config";
import { DemoRepository } from "@/lib/data/demo";
import { SupabaseRepository } from "@/lib/data/supabase";
import { SitesRepository } from "@/lib/data/sites-repository";
import type { Repository } from "@/lib/data/types";
import { withBackendOpportunities } from "@/lib/data/backend-opportunities";
import { Providers } from "./providers";

interface AuthState {
  session: Session | null;
  configured: boolean;
}
const AuthContext = createContext<AuthState>({ session: null, configured: false });
export const useAuth = () => useContext(AuthContext);
const RepositoryContext = createContext<Repository | null>(null);
export function useRepository(): Repository {
  const repo = useContext(RepositoryContext);
  if (!repo) throw new Error("useRepository must be used inside AuthProvider");
  return repo;
}

const cloud = runtime === "cloud";

function readCloudUserId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const data = body as { user_id?: unknown; user?: { id?: unknown } };
  const id = typeof data.user_id === "string" ? data.user_id : data.user?.id;
  return typeof id === "string" && id.trim() ? id : null;
}

function cloudSession(userId: string): Session {
  return { access_token: "sites-session", user: { id: userId } } as unknown as Session;
}

export async function probeCloudUser(): Promise<string | null> {
  try {
    const response = await fetch("/__qoder_auth/me", {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    return readCloudUserId(await response.json());
  } catch {
    return null;
  }
}

// 默认公开 Demo（无需注册）；登录后切换为真实模式（RLS 按用户隔离）。
export function AuthProvider({ children }: { children: ReactNode }) {
  const [{ session, ready, error }, setAuth] = useState({
    session: null as Session | null, ready: cloud ? false : !supabaseClient, error: "",
  });
  const userId = session?.user.id;
  const repository = useMemo(
    () => cloud
      ? userId ? new SitesRepository(userId) : new DemoRepository()
      : supabaseClient && userId
        ? withBackendOpportunities(new SupabaseRepository(supabaseClient, userId))
        : withBackendOpportunities(new DemoRepository()),
    [userId],
  );

  useEffect(() => {
    if (cloud) {
      let active = true;
      void probeCloudUser().then((id) => {
        if (active) setAuth({ session: id ? cloudSession(id) : null, ready: true, error: "" });
      });
      return () => { active = false; };
    }
    if (!supabaseClient) return;
    let active = true;
    let observedEvent = false;
    // Subscribe first so a slow initial read cannot overwrite a newer login/logout.
    const { data: sub } = supabaseClient.auth.onAuthStateChange((_e, s) => {
      observedEvent = true;
      if (active) setAuth({ session: s, ready: true, error: "" });
    });
    supabaseClient.auth.getSession().then(({ data, error: e }) => {
      if (active && !observedEvent) {
        setAuth({ session: data.session, ready: true, error: e?.message ?? "" });
      }
    }).catch(() => {
      if (active && !observedEvent) setAuth({ session: null, ready: true, error: "会话加载失败，请重试" });
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  if (error) return <div role="alert" className="p-8">{error}<Button className="ml-3" onClick={() => window.location.reload()}>重试</Button></div>;

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return (
    <AuthContext.Provider value={{ session, configured: cloud || Boolean(supabaseClient) }}>
      <RepositoryContext.Provider value={repository}>
        {/* A separate cache for every principal; repository is ready before queries mount. */}
        <Providers key={userId ?? "demo"}>{children}</Providers>
      </RepositoryContext.Provider>
    </AuthContext.Provider>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  // Qoder 登录回跳后（/login/ 静态回退页）直接进入个人空间，避免停在登录卡片。
  useEffect(() => {
    if (!cloud) return;
    let active = true;
    void probeCloudUser().then((id) => {
      if (active && id) navigate("/app", { replace: true });
    });
    return () => { active = false; };
  }, [navigate]);

  async function submit() {
    if (!supabaseClient) return;
    setBusy(true);
    setErr(null);
    setMessage("");
    try {
      const { data, error } = mode === "in"
        ? await supabaseClient.auth.signInWithPassword({ email, password })
        : await supabaseClient.auth.signUp({ email, password });
      if (error) setErr(error.message);
      else if (data.session) navigate("/app");
      else setMessage("注册成功，请查收确认邮件后登录。");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "认证失败，请重试");
    } finally { setBusy(false); }
  }

  if (cloud) {
    // 平台静态托管只对“目录/尾斜杠”做回退，回跳路径必须带尾斜杠才能加载应用。
    const basePath = location.pathname.endsWith("/") ? location.pathname : `${location.pathname}/`;
    const returnPath = encodeURIComponent(basePath + location.search);
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <GraduationCap className="size-5 text-primary" />CampusMate
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">使用 Qoder 账号登录后进入云端个人空间；未登录时提供演示数据。</p>
            <Button asChild>
              <a href={`/__qoder_auth/start?return_path=${returnPath}`}>使用 Qoder 登录</a>
            </Button>
            <Button variant="link" size="sm" onClick={() => navigate("/app")}>
              无需登录，先体验 Demo
            </Button>
            <p className="text-xs text-muted-foreground">数据按 Qoder 账号隔离，保存在站点云端。</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <GraduationCap className="size-5 text-primary" />CampusMate
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div><Label htmlFor="campusmate-login-email">邮箱</Label><Input id="campusmate-login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div><Label htmlFor="campusmate-login-password">密码</Label><Input id="campusmate-login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          {message && <p role="status" className="text-sm">{message}</p>}
          {!supabaseClient && <p className="text-sm text-muted-foreground">尚未配置 Supabase，请先体验 Demo。</p>}
          <Button disabled={!supabaseClient || busy || !email || !password} onClick={submit}>
            {mode === "in" ? "登录" : "注册"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMode(mode === "in" ? "up" : "in")}>
            {mode === "in" ? "没有账号？注册" : "已有账号？登录"}
          </Button>
          <Button variant="link" size="sm" onClick={() => navigate("/app")}>
            无需注册，先体验 Demo
          </Button>
          <p className="text-xs text-muted-foreground">真实模式数据按用户隔离（RLS）。请勿提交不必要的敏感材料。</p>
        </CardContent>
      </Card>
    </div>
  );
}

export interface SignOutResult {
  ok: boolean;
  message?: string;
  accountUrl?: string;
}

export async function signOut(): Promise<SignOutResult> {
  if (cloud) {
    try {
      const logout = await fetch("/__qoder_auth/logout", { method: "POST", credentials: "include" });
      if (!logout.ok) throw new Error(`logout_http_${logout.status}`);
      if (await probeCloudUser()) throw new Error("session_still_active");
      return { ok: true };
    } catch {
      return {
        ok: false,
        message: "平台会话仍由 Qoder 统一管理，请到 Qoder 账户中心退出。",
        accountUrl: "https://qoder.com/account",
      };
    }
  }
  await supabaseClient?.auth.signOut();
  return { ok: true };
}
