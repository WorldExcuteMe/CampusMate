import { createHandler, supabaseAuthorizer, type ServerProvider } from "./handler.ts";

// Production: configure these in server-side deployment secrets, never VITE_*.
const env = (name: string) => Deno.env.get(name) ?? "";
export const handler = createHandler({
  authorize: supabaseAuthorizer(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY")),
  providers: (): ServerProvider[] => env("LLM_API_KEY") ? [{
    id: "builtin-deepseek", name: env("LLM_DISPLAY_NAME") || "服务端模型",
    baseUrl: env("LLM_BASE_URL") || "https://api.deepseek.com",
    protocol: "openai", model: env("LLM_MODEL") || "deepseek-chat", apiKey: env("LLM_API_KEY"),
  }] : [],
  allowedOrigins: env("AI_ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean),
});
