import { MockProvider } from "./mock";
import { listProviders, ProxyProvider } from "./proxy";
import type { LlmProvider, LlmRequest, LlmResult } from "./types";

/** Availability is discovered server-side; the result, not the adapter, determines Mock status. */
export class BrowserProvider implements LlmProvider {
  readonly name = "auto";
  readonly mock = false;

  async extractNotice(req: LlmRequest): Promise<LlmResult> {
    try {
      const providers = (await listProviders()).filter((p) => p.hasKey);
      const selected = localStorage.getItem("campusmate.providerId");
      const provider = providers.find((p) => p.id === selected) ?? providers[0];
      if (provider) return await new ProxyProvider(provider.id).extractNotice(req);
    } catch {
      // Offline / unauthorized / unconfigured: never label a rule result as real AI.
    }
    return new MockProvider().extractNotice(req);
  }
}
