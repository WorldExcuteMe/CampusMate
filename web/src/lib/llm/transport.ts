const env = import.meta.env as Record<string, string | undefined>;
const base = (env.VITE_AI_BASE_URL || (import.meta.env.DEV ? "/api" : "/functions/v1/app")).replace(/\/$/, "");
let getAccessToken: () => Promise<string | null> = async () => null;

export function configureAiAuth(getToken: () => Promise<string | null>): void {
  getAccessToken = getToken;
}

export async function aiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = await getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(/^https?:\/\//.test(path) ? path : `${base}${path}`, {
    ...init, headers, cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(35_000),
  });
}
