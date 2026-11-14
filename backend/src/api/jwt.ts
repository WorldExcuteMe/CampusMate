// Supabase JWT 验签：HS256（legacy secret）+ ES256/RS256（新版非对称 JWKS 公钥）。
// 新版 Supabase 用 publishable key + 非对称签名；JWKS 公钥非密钥，可离线验签。
import { createHmac, timingSafeEqual, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import fs from "node:fs";

export interface JwtClaims { sub: string; exp?: number; role?: string; email?: string; }
interface Jwk { kty: string; kid?: string; alg?: string; crv?: string; x?: string; y?: string; n?: string; e?: string; }

function b64urlJson(seg: string): any { return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")); }

// 加载 JWKS：env SUPABASE_JWKS_JSON 或 backend/jwks.json（公钥，可离线）。
let cachedJwks: Jwk[] | null = null;
export function loadJwks(): Jwk[] {
  if (cachedJwks) return cachedJwks;
  try {
    const raw = process.env.SUPABASE_JWKS_JSON ?? fs.readFileSync(new URL("../../jwks.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw);
    cachedJwks = (parsed.keys ?? []) as Jwk[];
  } catch { cachedJwks = []; }
  return cachedJwks;
}

function jwkToKey(jwk: Jwk): KeyObject | null {
  try { return createPublicKey({ key: jwk as any, format: "jwk" }); } catch { return null; }
}

function verifyAsymmetric(alg: string, data: string, sig: Buffer, jwks: Jwk[], kid?: string): boolean {
  const candidates = kid ? jwks.filter((k) => k.kid === kid) : jwks;
  for (const jwk of candidates) {
    const key = jwkToKey(jwk);
    if (!key) continue;
    try {
      if (alg === "ES256") { if (cryptoVerify("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }, sig)) return true; }
      else if (alg === "RS256") { if (cryptoVerify("sha256", Buffer.from(data), key, sig)) return true; }
    } catch { /* try next */ }
  }
  return false;
}

export function verifySupabaseJwt(token: string, secret: string, nowSec?: number, jwks?: Jwk[]): JwtClaims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header: any;
  try { header = b64urlJson(h); } catch { return null; }
  const sig = Buffer.from(s, "base64url");
  const data = `${h}.${p}`;
  let ok = false;
  if (header?.alg === "HS256") {
    if (!secret) return null;
    const expected = createHmac("sha256", secret).update(data).digest();
    ok = expected.length === sig.length && timingSafeEqual(expected, sig);
  } else if (header?.alg === "ES256" || header?.alg === "RS256") {
    ok = verifyAsymmetric(header.alg, data, sig, jwks ?? loadJwks(), header.kid);
  } else {
    return null;
  }
  if (!ok) return null;
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