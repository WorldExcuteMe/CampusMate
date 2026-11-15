import type { ChatMessage } from "./types.ts";
import type { SessionPatch, LegacyMessage } from './session-management.ts';

export interface StoredSession {
  id: string; userId: string; title: string; mode: "auto" | "daily";
  summary?: string; summaryThroughSeq: number; createdAt: number; updatedAt: number;
  archived?: boolean; deletedAt?: number | null; revision?: number;
}
export interface StoredSessionMessage extends ChatMessage {
  id: string; userId: string; sessionId: string; turnId: string; messageKey: string;
  taskId?: string; seq: number; createdAt: number;
}
export interface AppendSessionMessage extends ChatMessage {
  userId: string; sessionId: string; turnId: string; messageKey: string; taskId?: string;
}
export interface SessionStore {
  create(input: { userId: string; id?: string; title?: string; mode?: "auto" | "daily" }): Promise<StoredSession>;
  get(userId: string, id: string): Promise<StoredSession | null>;
  list(userId: string): Promise<StoredSession[]>;
  patch(userId: string, id: string, patch: SessionPatch): Promise<StoredSession>;
  remove(userId: string, id: string, expectedRevision: number): Promise<StoredSession>;
  importLegacy(userId: string, id: string, messages: LegacyMessage[]): Promise<void>;
  legacyHistory(userId: string, id: string): Promise<LegacyMessage[]>;
  appendMessage(input: AppendSessionMessage): Promise<StoredSessionMessage>;
  listMessages(userId: string, sessionId: string, afterSeq?: number): Promise<StoredSessionMessage[]>;
  updateSummary(userId: string, sessionId: string, summary: string, throughSeq: number): Promise<StoredSession | null>;
}

export interface EncryptedSecret {
  algorithm: "AES-256-GCM"; keyVersion: string; nonce: string; tag: string; ciphertext: string;
}
export interface StoredProvider {
  userId: string; providerId: string; displayName: string; protocol: string; baseUrl: string; modelId: string;
  capabilities: Record<string, unknown>; contextLimit?: number; metadataSource: string;
  encryptedSecret?: EncryptedSecret; isDefault: boolean; createdAt: number; updatedAt: number;
}
export type ProviderWrite = Pick<StoredProvider, "userId" | "providerId" | "displayName" | "protocol" | "baseUrl" | "modelId">
  & Partial<Pick<StoredProvider, "capabilities" | "metadataSource" | "encryptedSecret" | "isDefault">>
  & { removeSecret?: boolean; contextLimit?: number | null };
export interface ProviderStore {
  upsert(input: ProviderWrite): Promise<StoredProvider>;
  get(userId: string, providerId: string): Promise<StoredProvider | null>;
  list(userId: string): Promise<StoredProvider[]>;
  delete(userId: string, providerId: string): Promise<boolean>;
}

export interface StoredArtifact {
  id: string; userId: string; taskId: string; documentId: string; revision: number;
  kind: string; inline?: unknown; storagePath?: string; sha256: string; createdAt: number;
}
export type ArtifactWrite = Omit<StoredArtifact, "id" | "documentId" | "revision" | "createdAt"> & { documentId?: string; revision?: number };
export interface ArtifactStore {
  create(input: ArtifactWrite): Promise<StoredArtifact>;
  get(userId: string, id: string): Promise<StoredArtifact | null>;
  listByTask(userId: string, taskId: string): Promise<StoredArtifact[]>;
}
