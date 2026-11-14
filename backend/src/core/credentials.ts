import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EncryptedSecret } from "./storage-contracts.ts";

// Keys stay in server environment; AAD prevents moving credentials across owners/providers.
export class CredentialVault {
  private keys: Record<string, Buffer> = Object.create(null);
  private version: string;
  constructor(env: Record<string, string | undefined>) {
    this.version = env.PROVIDER_KEY_VERSION ?? "v1";
    let old: Record<string, string> = {};
    try { old = env.PROVIDER_DECRYPTION_KEYS ? JSON.parse(env.PROVIDER_DECRYPTION_KEYS) : {}; }
    catch { throw new Error("模型历史主密钥配置无效"); }
    const raw = { ...old, ...(env.PROVIDER_MASTER_KEY ? { [this.version]: env.PROVIDER_MASTER_KEY } : {}) };
    for (const [version, encoded] of Object.entries(raw)) {
      if (typeof encoded !== "string") throw new Error("模型主密钥配置无效");
      const key = /^[a-f0-9]{64}$/i.test(encoded) ? Buffer.from(encoded, "hex") : Buffer.from(encoded, "base64");
      if (key.length !== 32) throw new Error("模型主密钥必须为32字节的base64或hex");
      this.keys[version] = key;
    }
  }
  encrypt(secret: string, userId: string, providerId: string): EncryptedSecret {
    const key = this.keys[this.version];
    if (!key) throw new Error("服务端未配置模型主密钥，无法保存API密钥");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(JSON.stringify([userId, providerId, this.version])));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return { algorithm: "AES-256-GCM", keyVersion: this.version, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }
  decrypt(secret: EncryptedSecret, userId: string, providerId: string): string {
    const key = this.keys[secret.keyVersion];
    if (!key) throw new Error("模型凭证解密密钥版本不可用");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.nonce, "base64"), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(JSON.stringify([userId, providerId, secret.keyVersion])));
      decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch { throw new Error("模型凭证验证失败，请重新保存密钥"); }
  }
}
