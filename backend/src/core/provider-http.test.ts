import { test } from "node:test";
import assert from "node:assert/strict";
import { providerUrl, createPublicLookup } from "./provider-http.ts";

test("BYOK只允许无凭证公开HTTPS，IPv6映射私网和保留地址不可绕过", () => {
  for (const url of ["http://example.com/v1", "https://user:key@example.com", "https://example.com?api_key=dummy", "https://example.com#dummy", "https://127.0.0.1", "https://169.254.169.254", "https://[::ffff:7f00:1]", "https://100.64.0.1", "https://224.1.1.1"]) assert.throws(() => providerUrl(url), /公开HTTPS/, url);
  assert.equal(providerUrl("https://gateway.example/v1").pathname, "/v1");
});
test("连接lookup直接交付校验过的地址，混入私网则拒绝整组", async () => {
  const call = (addresses: { address: string; family: number }[]) => new Promise<unknown>((resolve, reject) => createPublicLookup(async () => addresses)("gateway.example", { all: true }, (error, results) => error ? reject(error) : resolve(results)));
  assert.deepEqual(await call([{ address: "93.184.216.34", family: 4 }]), [{ address: "93.184.216.34", family: 4 }]);
  await assert.rejects(() => call([{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]), /非公开网络/);
});
