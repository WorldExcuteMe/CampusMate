import type { TestContext } from "node:test";
import { buildContext, type AppContext } from "../app-context.ts";
import type { ChatMessage } from "../core/types.ts";
import { PGlitePool } from "./pglite-pool.ts";
import type { SqlPool } from "./sql.ts";
import { readMigrations } from "./migrations.ts";

export const OWNER = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";

// Consumer contracts let the first Red exercise existing buildContext without importing missing modules.
export interface SessionRecord { id: string; userId: string; summary?: string; summaryThroughSeq: number; }
export interface StoredMessage extends ChatMessage { id: string; seq: number; turnId: string; messageKey: string; taskId?: string; }
export interface SessionConsumer {
  create(input: { userId: string; id?: string; title?: string; mode?: "auto" | "daily" }): Promise<SessionRecord>;
  get(userId: string, id: string): Promise<SessionRecord | null>;
  appendMessage(input: ChatMessage & { userId: string; sessionId: string; turnId: string; messageKey: string; taskId?: string }): Promise<StoredMessage>;
  listMessages(userId: string, sessionId: string, afterSeq?: number): Promise<StoredMessage[]>;
  updateSummary(userId: string, sessionId: string, summary: string, throughSeq: number): Promise<SessionRecord | null>;
}
export interface SecretEnvelope { algorithm: "AES-256-GCM"; keyVersion: string; nonce: string; tag: string; ciphertext: string; }
export interface ProviderRecord {
  userId: string; providerId: string; displayName: string; protocol: string; baseUrl: string; modelId: string;
  encryptedSecret?: SecretEnvelope; isDefault: boolean;
}
export interface ProviderConsumer {
  upsert(input: Omit<ProviderRecord, "isDefault"> & { isDefault?: boolean; removeSecret?: boolean }): Promise<ProviderRecord>;
  get(userId: string, providerId: string): Promise<ProviderRecord | null>;
  list(userId: string): Promise<ProviderRecord[]>;
}
export interface ArtifactRecord { id: string; userId: string; taskId: string; documentId: string; revision: number; kind: string; inline?: unknown; sha256: string; }
export interface ArtifactConsumer {
  create(input: Omit<ArtifactRecord, "id" | "documentId" | "revision"> & { documentId?: string; revision?: number }): Promise<ArtifactRecord>;
  get(userId: string, id: string): Promise<ArtifactRecord | null>;
  listByTask(userId: string, taskId: string): Promise<ArtifactRecord[]>;
}
export type StorageContext = AppContext & {
  sessionStore?: SessionConsumer;
  providerStore?: ProviderConsumer;
  artifactStore?: ArtifactConsumer;
  dispose?: () => Promise<void>;
};

export function contextFor(pool?: SqlPool): StorageContext {
  return Reflect.apply(buildContext, undefined, [{}, { pool }]) as StorageContext;
}

export async function storageFixture(t: TestContext) {
  const pool = await PGlitePool.create();
  t.after(() => pool.end());
  await pool.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  const root = new URL("../../../", import.meta.url);
  for (const migration of await readMigrations()) {
    await pool.exec(migration.sql.replace(/create extension if not exists pgcrypto;/gi, ""));
  }
  await pool.query("insert into auth.users (id,email) values ($1,'owner@fixture.test'),($2,'other@fixture.test')", [OWNER, OTHER]);
  return { pool, first: contextFor(pool), second: contextFor(pool), rebuild: () => contextFor(pool) };
}
