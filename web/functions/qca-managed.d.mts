// Types for the verbatim official helper in ./cloud-agents.mjs.
export class CloudAgentsError extends Error {
  readonly code: string;
  readonly status: number;
  readonly outcome: string;
  diagnosticId?: string;
  constructor(code: string, status?: number, outcome?: string);
}

export interface CloudAgentsLease {
  read(): Promise<Record<string, unknown> | null>;
  write(record: Record<string, unknown>): Promise<void>;
  assertHeld(): Promise<void>;
}
export interface CloudAgentsCoordinator {
  withLock<T>(key: string, callback: (lease: CloudAgentsLease) => Promise<T>): Promise<T>;
}
export interface CloudResource {
  id: string;
  version?: number;
  archived_at?: string | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface CloudAgentsClient {
  request(path: string, options?: { method?: "GET" | "POST"; body?: unknown; idempotencyKey?: string }): Promise<unknown>;
  findResources(kind: "agents" | "environments", metadata: Record<string, unknown>, maxPages?: number): Promise<CloudResource[]>;
  openStream(sessionId: string, options?: { lastEventId?: string; signal?: AbortSignal }): Promise<{ body: ReadableStream<Uint8Array>; close: () => void }>;
}
export interface CloudAgentsClientOptions {
  origin: string;
  getToken?: () => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  diagnostics?: (event: Record<string, unknown>) => void;
}
export function createCloudAgentsClient(options?: CloudAgentsClientOptions): CloudAgentsClient;

export interface EnsureCloudResourcesOptions {
  client: CloudAgentsClient;
  coordinator: CloudAgentsCoordinator;
  applicationScope: string;
  agent: Record<string, unknown> & { name: string };
  environment: Record<string, unknown> & { name: string };
}
export function ensureCloudResources(options: EnsureCloudResourcesOptions): Promise<{
  agent: { type: "agent"; id: string; version: number };
  environment_id: string;
}>;
