import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { GraduationCap, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabaseClient } from "./config";
import { DemoRepository } from "@/lib/data/demo";
import { SupabaseRepository } from "@/lib/data/supabase";
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

// 默认公开 Demo（无需注册）；登录后切换为真实模式（RLS 按用户隔离）。
export function AuthProvider({ children }: { children: ReactNode }) {
  const [{ session, ready, error }, setAuth] = useState({
    session: null as Session | null, ready: !supabaseClient, error: "",
  });
  const userId = session?.user.id;
  const repository = useMemo(
    () => supabaseClient && userId
      ? withBackendOpportunities(new SupabaseRepository(supabaseClient, userId))
      : withBackendOpportunities(new DemoRepository()),
    [userId],
  );

  useEffect(() => {
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
    <AuthContext.Provider value={{ session, configured: Boolean(supabaseClient) }}>
      <RepositoryContext.Provider value={repository}>
        {/* A separate cache for every principal; repository is ready before queries mount. */}
        <Providers key={userId ?? "demo"}>{children}</Providers>
      </RepositoryContext.Provider>
    </AuthContext.Provider>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [message, setMessage] = useState("");

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

export async function signOut(): Promise<void> {
  await supabaseClient?.auth.signOut();
}
