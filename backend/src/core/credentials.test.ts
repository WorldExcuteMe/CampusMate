import { test } from "node:test";
import assert from "node:assert/strict";
import { CredentialVault } from "./credentials.ts";

test("GCM凭证绑定owner/provider，随机nonce，篡改和缺主密钥均拒绝", () => {
  const vault = new CredentialVault({ PROVIDER_MASTER_KEY: Buffer.alloc(32, 5).toString("base64") });
  const a = vault.encrypt("dummy-key", "alice", "custom"), b = vault.encrypt("dummy-key", "alice", "custom");
  assert.notEqual(a.nonce, b.nonce);
  assert.equal(vault.decrypt(a, "alice", "custom"), "dummy-key");
  assert.throws(() => vault.decrypt(a, "bob", "custom"), /验证失败/);
  assert.throws(() => vault.decrypt(a, "alice", "another"), /验证失败/);
  assert.throws(() => vault.decrypt({ ...a, tag: Buffer.alloc(16).toString("base64") }, "alice", "custom"), /验证失败/);
  assert.throws(() => new CredentialVault({}).encrypt("dummy", "a", "b"), /未配置/);
});
test("主密钥轮换显式保留旧版本可读，新版本写入", () => {
  const oldKey = Buffer.alloc(32, 1).toString("base64");
  const old = new CredentialVault({ PROVIDER_MASTER_KEY: oldKey }).encrypt("fixture", "alice", "custom");
  const rotated = new CredentialVault({ PROVIDER_KEY_VERSION: "v2", PROVIDER_MASTER_KEY: Buffer.alloc(32, 2).toString("base64"), PROVIDER_DECRYPTION_KEYS: JSON.stringify({ v1: oldKey }) });
  assert.equal(rotated.decrypt(old, "alice", "custom"), "fixture");
  assert.equal(rotated.encrypt("next", "alice", "custom").keyVersion, "v2");
});
