import type { ExtractInput, ExtractedNotice } from "../schemas";

export interface LlmRequest {
  task: string;
  input: ExtractInput;
  signal?: AbortSignal;
}

export interface LlmResult {
  extracted: ExtractedNotice;
  provider: string;
  model: string;
  tokenUsage: { input: number; output: number };
  mock: boolean;
}

export interface LlmProvider {
  readonly name: string;
  readonly mock: boolean;
  extractNotice(req: LlmRequest): Promise<LlmResult>;
}

export interface LlmConfig {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export const LLM_TIMEOUT_MS = 30_000;
export const LLM_MAX_RETRIES = 2;