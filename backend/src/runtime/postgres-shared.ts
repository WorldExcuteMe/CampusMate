import { createHash } from "node:crypto";
import type { AppendSessionMessage, ArtifactWrite, EncryptedSecret } from "../core/storage-contracts.ts";
import type { SqlClient } from "./sql.ts";
import { canonicalArgs } from "./idempotency.ts";

export type DbRow = Record<string, unknown>;
export const json = (value: unknown): string => JSON.stringify(value ?? null);
export const millis = (value: unknown): number => value instanceof Date ? value.getTime() : Date.parse(String(value));
// pg parses SQL DATE at local midnight; UTC conversion can shift the calendar day.
export const calendarDate = (value: unknown): string => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
  : String(value).slice(0, 10);
export const optionalText = (value: unknown): string | undefined => value == null ? undefined : String(value);
export function requireUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("Invalid UUID");
}
export function assertSecret(secret: EncryptedSecret | undefined): void {
  if (secret === undefined) return;
  const keys = Object.keys(secret).sort().join(",");
  if (keys !== "algorithm,ciphertext,keyVersion,nonce,tag" || secret.algorithm !== "AES-256-GCM" ||
    ![secret.keyVersion, secret.nonce, secret.tag, secret.ciphertext].every((v) => typeof v === "string" && v.length > 0)) {
    throw new Error("Invalid encrypted credential envelope");
  }
}
export function messageEnvelope(input: AppendSessionMessage) {
  return { role: input.role, content: input.content, ...(input.tool_calls ? { tool_calls: input.tool_calls } : {}), ...(input.tool_call_id ? { tool_call_id: input.tool_call_id } : {}), ...(input.role === 'assistant' && input.reasoning_content !== undefined ? { reasoning_content: input.reasoning_content, reasoning_source: input.reasoning_source } : {}) };
}
export function sameJson(first: unknown, second: unknown): boolean {
  return canonicalJson(first) === canonicalJson(second);
}
// Normalize to persisted JSON values, then sort object keys recursively; array order stays significant.
export const canonicalJson = (value: unknown): string => canonicalArgs(JSON.parse(json(value)));
export function validateArtifact(input: ArtifactWrite): void {
  if (!Number.isInteger(input.revision ?? 1) || (input.revision ?? 1) < 1) throw new Error("Invalid artifact revision");
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error("Invalid artifact hash");
  if (input.inline !== undefined) {
    const hash = createHash("sha256").update(canonicalJson(input.inline)).digest("hex");
    if (hash !== input.sha256) throw new Error("Artifact content hash mismatch");
  } else throw new Error("Artifact requires verified inline content; path-only content is not trusted");
}
export async function assertTaskOwner(client: SqlClient, userId: string, taskId: string, sessionId?: string): Promise<void> {
  const r = await client.query<DbRow>("select user_id,session_id from agent_tasks where id=$1", [taskId]);
  if (r.rows[0]?.user_id !== userId || (sessionId !== undefined && r.rows[0]?.session_id !== sessionId)) throw new Error("Task owner/session forbidden");
}
export async function assertTermOwner(client: SqlClient, userId: string, termId: string): Promise<void> {
  const r = await client.query("select id from academic_terms where id=$1 and user_id=$2", [termId, userId]);
  if (!r.rows.length) throw new Error("Term owner forbidden");
}
