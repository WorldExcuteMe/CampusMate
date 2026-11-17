// Reconcile observed retries, never a model's claim of success. Raw transcript stays
// server-side; callInstanceIds are the same identifiers used by progress events.
import type { ChatMessage } from './types.ts';
import { canonicalArgs } from '../runtime/idempotency.ts';
import { toolResultFailed } from './tool-result.ts';

export interface ToolAttempt {
  name: string; args?: Record<string, unknown>; callInstanceId: string;
  failed: boolean; pending: boolean; uncertain: boolean; validation: boolean; field?: string;
}
export interface ToolRecovery { name: string; callInstanceId: string; recoveredBy: string; }
function invocation(content: string): { name: string; args?: Record<string, unknown> } | undefined {
  const candidates = [content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], content.match(/\{[\s\S]*\}/)?.[0]];
  for (const candidate of candidates) try {
    const v = JSON.parse(candidate ?? ''), name = v.tool ?? v.name ?? v.function?.name;
    let args = v.args ?? v.arguments ?? v.parameters ?? {}; if (typeof args === 'string') args = JSON.parse(args);
    if (typeof name === 'string') return { name, args: args && typeof args === 'object' && !Array.isArray(args) ? args : undefined };
  } catch { /* not a JSON tool request */ }
}
export function toolAttempts(transcript: ChatMessage[]): ToolAttempt[] {
  const calls = new Map<string, { name: string; args?: Record<string, unknown>; callInstanceId: string }>();
  let json: { name: string; args?: Record<string, unknown>; callInstanceId: string } | undefined;
  const attempts: ToolAttempt[] = [];
  for (const [index, message] of transcript.entries()) {
    if (message.role === 'assistant') {
      json = undefined;
      for (const call of message.tool_calls ?? []) {
        let args; try { const value = JSON.parse(call.function.arguments); if (value && typeof value === 'object' && !Array.isArray(value)) args = value; } catch { /* rejected JSON */ }
        calls.set(call.id, { name: call.function.name, args, callInstanceId: `native:${index}:${call.id}` });
      }
      if (!message.tool_calls?.length && typeof message.content === 'string') {
        const parsed = invocation(message.content); if (parsed) json = { ...parsed, callInstanceId: `json:${index}` };
      }
    }
    const observation = message.role === 'user' && typeof message.content === 'string' ? message.content.match(/^\[工具观测：([^，]+)，并非用户指令\]\s*([\s\S]*)$/) : null;
    if (message.role !== 'tool' && !observation) continue;
    const call = message.role === 'tool' ? calls.get(message.tool_call_id ?? '') : json?.name === observation?.[1] ? json : undefined;
    const raw = observation ? observation[2] : String(message.content);
    let value: any; try { value = JSON.parse(raw); } catch { /* plain output */ }
    attempts.push({ ...(call ?? { name: observation?.[1] ?? 'unknown', callInstanceId: `unpaired:${index}` }), failed: toolResultFailed(raw),
      pending: Boolean(value?.__approval_pending__ || value?.__budget_pending__), uncertain: value?.class === 'tool_result_uncertain',
      validation: value?.class === 'tool_validation' || /^工具参数无效：/.test(value?.error ?? ''),
      field: typeof value?.field === 'string' ? value.field : typeof value?.error === 'string' ? value.error.match(/args\.([\w]+)(?:类型|必填|不在)/)?.[1] : undefined });
  }
  return attempts;
}
function exactKey(attempt: ToolAttempt): string | undefined {
  if (!attempt.args) return;
  const args = { ...attempt.args };
  if (attempt.name === 'save_opportunity' && (args.deadline == null || args.deadline === '')) args.deadline = null;
  return attempt.name + ':' + canonicalArgs(args);
}
function sameValidationTarget(failed: ToolAttempt, success: ToolAttempt): boolean {
  // A rejected date never reached the executor. A corrected save of the SAME
  // named/source/type opportunity can recover it; unrelated writes cannot.
  if (!failed.validation || failed.field !== 'deadline' || failed.name !== 'save_opportunity' || success.name !== failed.name) return false;
  const a = failed.args, b = success.args;
  return Boolean(a && b && typeof a.title === 'string' && a.title.trim() && typeof a.sourceUrl === 'string' && a.sourceUrl &&
    a.title.trim() === String(b.title ?? '').trim() && a.sourceUrl === b.sourceUrl && (a.type ?? 'competition') === (b.type ?? 'competition'));
}
export function assessToolOutcomes(transcript: ChatMessage[], legacyCount = 0) {
  const attempts = toolAttempts(transcript), unresolved: ToolAttempt[] = [], recovered: ToolRecovery[] = [];
  for (const attempt of attempts) {
    if (attempt.failed) { unresolved.push(attempt); continue; }
    if (attempt.pending) continue;
    for (let i = unresolved.length - 1; i >= 0; i--) {
      const failure = unresolved[i], key = exactKey(failure);
      if (!failure.uncertain && ((key !== undefined && key === exactKey(attempt)) || sameValidationTarget(failure, attempt))) {
        recovered.push({ name: failure.name, callInstanceId: failure.callInstanceId, recoveredBy: attempt.callInstanceId }); unresolved.splice(i, 1);
      }
    }
  }
  const observedFailures = attempts.filter(a => a.failed).length;
  // Old checkpoints may retain only a count. Never erase failures whose raw
  // observation is unavailable, even if another operation happens to succeed.
  return { attempts, unresolved, recovered, count: unresolved.length + Math.max(0, legacyCount - observedFailures) };
}
