import type { ProviderStore, ProviderWrite, StoredProvider } from "../core/storage-contracts.ts";
import type { SqlPool } from "./sql.ts";
import { readQuery } from "./sql.ts";
import { assertSecret, json, millis, type DbRow } from "./postgres-shared.ts";

function provider(r: DbRow): StoredProvider { return { userId: String(r.user_id), providerId: String(r.provider_id), displayName: String(r.display_name), protocol: String(r.protocol), baseUrl: String(r.base_url), modelId: String(r.model_id), capabilities: r.capabilities as Record<string, unknown>, contextLimit: r.context_limit == null ? undefined : Number(r.context_limit), metadataSource: String(r.metadata_source), encryptedSecret: r.encrypted_secret == null ? undefined : r.encrypted_secret as StoredProvider["encryptedSecret"], isDefault: Boolean(r.is_default), createdAt: millis(r.created_at), updatedAt: millis(r.updated_at) }; }
export class PostgresProviderStore implements ProviderStore {
  private pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }
  async upsert(input: ProviderWrite) {
    assertSecret(input.encryptedSecret);
    if (!input.providerId || !input.baseUrl || !input.modelId) throw new Error("Provider configuration incomplete");
    return this.pool.transaction(async (client) => {
      // Serialize default changes even if neither provider row existed before this transaction.
      await client.query("select id from auth.users where id=$1 for update", [input.userId]);
      const prev = await client.query<DbRow>("select * from user_llm_providers where user_id=$1 and provider_id=$2", [input.userId, input.providerId]);
      const old = prev.rows[0] ? provider(prev.rows[0]) : undefined;
      const isDefault = input.isDefault ?? old?.isDefault ?? false;
      if (isDefault) await client.query("update user_llm_providers set is_default=false where user_id=$1", [input.userId]);
      const secret = input.removeSecret ? null : input.encryptedSecret ?? old?.encryptedSecret ?? null;
      const r = await client.query<DbRow>(`insert into user_llm_providers(user_id,provider_id,display_name,protocol,base_url,model_id,capabilities,context_limit,metadata_source,encrypted_secret,is_default)
        values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11) on conflict(user_id,provider_id) do update set display_name=excluded.display_name,protocol=excluded.protocol,base_url=excluded.base_url,model_id=excluded.model_id,capabilities=excluded.capabilities,context_limit=excluded.context_limit,metadata_source=excluded.metadata_source,encrypted_secret=excluded.encrypted_secret,is_default=excluded.is_default,updated_at=now() returning *`,
      [input.userId, input.providerId, input.displayName, input.protocol, input.baseUrl, input.modelId, json(input.capabilities ?? old?.capabilities ?? {}), input.contextLimit === null ? null : input.contextLimit ?? old?.contextLimit ?? null, input.metadataSource ?? old?.metadataSource ?? "configured", secret === null ? null : json(secret), isDefault]);
      return provider(r.rows[0]);
    });
  }
  async get(userId: string, providerId: string) { const r = await readQuery<DbRow>(this.pool, "select * from user_llm_providers where user_id=$1 and provider_id=$2", [userId, providerId]); return r.rows[0] ? provider(r.rows[0]) : null; }
  async list(userId: string) { const r = await readQuery<DbRow>(this.pool, "select * from user_llm_providers where user_id=$1 order by created_at,provider_id", [userId]); return r.rows.map(provider); }
  async delete(userId: string, providerId: string) { return (await this.pool.query("delete from user_llm_providers where user_id=$1 and provider_id=$2", [userId, providerId])).rowCount > 0; }
}
