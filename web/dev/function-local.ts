// Same authenticated production handler, bound to loopback for local validation.
import { handler } from "../functions/runtime.ts";
Deno.serve({ hostname: "127.0.0.1", port: 8787 }, handler);
