import {
  extractInputSchema,
  type Classification,
  type ExtractInput,
  type ExtractedNotice,
} from "../schemas";
import type { LlmProvider } from "../llm/types";
import { errorMessage } from "../llm/errors";
import { classify } from "./classifier";
import { uid } from "../data/types";

export interface AgentRun {
  id: string;
  taskType: string;
  status: "succeeded" | "failed";
  startedAt: string;
  completedAt: string;
  model: string;
  provider: string;
  mock: boolean;
  tokenUsage: { input: number; output: number };
  error?: string;
}

export interface InboxPipelineResult {
  extracted: ExtractedNotice;
  classification: Classification;
  run: AgentRun;
}

export async function runInboxPipeline(
  rawInput: ExtractInput,
  provider: LlmProvider,
): Promise<InboxPipelineResult> {
  const input = extractInputSchema.parse(rawInput);
  const startedAt = new Date().toISOString();
  try {
    const result = await provider.extractNotice({ task: "inbox.extract", input });
    const classification = classify(result.extracted, input.rawText);
    const run: AgentRun = {
      id: uid(),
      taskType: "inbox.extract",
      status: "succeeded",
      startedAt,
      completedAt: new Date().toISOString(),
      model: result.model,
      provider: result.provider,
      mock: result.mock,
      tokenUsage: result.tokenUsage,
    };
    return { extracted: result.extracted, classification, run };
  } catch (err) {
    const run: AgentRun = {
      id: uid(),
      taskType: "inbox.extract",
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      model: provider.name,
      provider: provider.name,
      mock: provider.mock,
      tokenUsage: { input: 0, output: 0 },
      error: errorMessage(err),
    };
    throw Object.assign(err instanceof Error ? err : new Error(errorMessage(err)), { run });
  }
}
