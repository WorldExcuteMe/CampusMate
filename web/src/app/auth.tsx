import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { GraduationCap, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabaseClient, setRepository } from "./config";
import { DemoRepository } from "@/lib/data/demo";
import { SupabaseRepository } from "@/lib/data/supabase";

interface AuthState {
  session: Session | null;
  configured: boolean;
}
const AuthContext = createContext<AuthState>({ session: null, configured: false });
export const useAuth = () => useContext(AuthContext);

// 默认公开 Demo（无需注册）；登录后切换为真实模式（RLS 按用户隔离）。
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!supabaseClient);

  useEffect(() => {
    const db = supabaseClient;
    if (!db) return;
    let disposed = false, revision = 0, owner: string | undefined;
    const apply = (next: Session | null) => {
      if (disposed) return;
      const nextOwner = next?.user.id ?? "demo";
      if (nextOwner !== owner) {
        // Switch before children can query under the new identity, including reload.
        setRepository(next ? new SupabaseRepository(db, next.user.id) : new DemoRepository());
        queryClient.clear();
        owner = nextOwner;
      }
      setSession(next);
      setReady(true);
    };
    const initialRevision = revision;
    void db.auth.getSession().then(({ data }) => { if (revision === initialRevision) apply(data.session); }).catch(() => { if (revision === initialRevision) apply(null); });
    const { data: sub } = db.auth.onAuthStateChange((_e, next) => { revision++; apply(next); });
    return () => { disposed = true; sub.subscription.unsubscribe(); };
  }, [queryClient]);

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return (
    <AuthContext.Provider value={{ session, configured: Boolean(supabaseClient) }}>
      <div key={session?.user.id ?? "demo"}>{children}</div>
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

  async function submit() {
    if (!supabaseClient) return;
    setBusy(true);
    setErr(null);
    const { error } =
      mode === "in"
        ? await supabaseClient.auth.signInWithPassword({ email, password })
        : await supabaseClient.auth.signUp({ email, password });
    setBusy(false);
    if (error) setErr(error.message);
    else navigate("/app");
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
          <div><Label>邮箱</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div><Label>密码</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <Button disabled={busy || !email || !password} onClick={submit}>
            {mode === "in" ? "登录" : "注册"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMode(mode === "in" ? "up" : "in")}>
            {mode === "in" ? "没有账号？注册" : "已有账号？登录"}
          </Button>
          <Button variant="link" size="sm" onClick={() => navigate("/app")}>
            无需注册，先体验 Demo
          </Button>
          <p className="text-xs text-muted-foreground">真实模式数据按用户隔离（RLS）；聊天记录与简历属敏感材料，可在设置中删除。</p>
        </CardContent>
      </Card>
    </div>
  );
}

export async function signOut(): Promise<void> {
  await supabaseClient?.auth.signOut();
}
