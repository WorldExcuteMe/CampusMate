// Supabase JWT 验签（HS256，node:crypto，零依赖）。取 sub=auth.uid，校验 exp。
import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtClaims { sub: string; exp?: number; role?: string; email?: string; }

function b64urlJson(seg: string): any {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

export function verifySupabaseJwt(token: string, secret: string, nowSec?: number): JwtClaims | null {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header: any;
  try { header = b64urlJson(h); } catch { return null; }
  if (header?.alg !== "HS256") return null;
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const sig = Buffer.from(s, "base64url");
  if (expected.length !== sig.length || !timingSafeEqual(expected, sig)) return null;
  let claims: any;
  try { claims = b64urlJson(p); } catch { return null; }
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && now > claims.exp) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  return { sub: claims.sub, exp: claims.exp, role: claims.role, email: claims.email };
}

export function bearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// 测试/开发辅助：签发 HS256 token（生产由 Supabase Auth 签发）。
export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = enc({ alg: "HS256", typ: "JWT" });
  const p = enc(claims);
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}