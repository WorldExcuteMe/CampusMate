// Deployment entry point for the Sites Function.
// The Sites Worker injects `_qoder/backend.mjs` before deployment; it is never
// committed or stubbed here. Local development keeps using ./runtime.ts through
// dev/function-local.ts.
import { createDatabaseClient, createSiteContext, requireUser, errorResponse } from "./_qoder/backend.mjs";
import { CAMPUSMATE_SITES } from "./sites-config.ts";
import { createProductionSites } from "./sites-production.ts";

const handle = createProductionSites({
  db: createDatabaseClient(),
  requireUser,
  config: CAMPUSMATE_SITES,
  // QODER_PAT is a platform-managed Secret read per request inside the handler.
  getToken: () => Deno.env.get("QODER_PAT"),
});

Deno.serve(async request => {
  let context;
  try {
    context = createSiteContext(request);
    return await handle(context);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
