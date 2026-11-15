import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { CompanionRegistry, checkFsPath, checkTerminal, checkGroup, manifestCapabilities, CLOUD_DEFAULT_CAPABILITIES } from "./companion.ts";

const root = path.resolve("/home/user/workspace");

test("checkFsPath 授权目录内允许，越界/.. 逃逸拒绝", () => {
  const scopes = { fsPaths: [root] };
  assert.equal(checkFsPath(scopes, path.join(root, "a.txt"), false).ok, true);
  assert.equal(checkFsPath(scopes, path.join(root, "sub/b.txt"), true).ok, true);
  assert.equal(checkFsPath(scopes, path.join(root, "../secret.txt"), false).ok, false);
  assert.equal(checkFsPath(scopes, "/etc/passwd", false).ok, false);
  assert.equal(checkFsPath({}, path.join(root, "a"), false).ok, false);
});

test("checkTerminal 白名单前缀允许，拼接/元字符拒绝", () => {
  const scopes = { terminalAllowlist: ["ls", "python script.py"] };
  assert.equal(checkTerminal(scopes, "ls -la").ok, true);
  assert.equal(checkTerminal(scopes, "python script.py").ok, true);
  assert.equal(checkTerminal(scopes, "rm -rf /").ok, false);
  assert.equal(checkTerminal(scopes, "ls; rm -rf /").ok, false);
  assert.equal(checkTerminal(scopes, "ls | cat").ok, false);
  assert.equal(checkTerminal({}, "ls").ok, false);
});

test("checkGroup 授权群限定，多群不默认全群", () => {
  assert.equal(checkGroup({ qqGroups: ["111"] }, undefined).group, "111");
  assert.equal(checkGroup({ qqGroups: ["111", "222"] }, undefined).ok, false);
  assert.equal(checkGroup({ qqGroups: ["111"] }, "222").ok, false);
  assert.equal(checkGroup({ qqGroups: ["111"] }, "111").ok, true);
  assert.equal(checkGroup({}, "111").ok, false);
});

test("云端默认 Manifest 不含本机能力；Companion 注册后叠加", () => {
  const reg = new CompanionRegistry();
  const before = manifestCapabilities(reg, "u1");
  assert.ok(!before.some((c) => c.startsWith("host.") || c.startsWith("ingest.")));
  assert.deepEqual(before, [...CLOUD_DEFAULT_CAPABILITIES]);
  reg.register({ userId: "u1", capabilities: ["host.terminal", "ingest.qq"], grantedScopes: { terminalAllowlist: ["ls"], qqGroups: ["111"] } });
  const after = manifestCapabilities(reg, "u1");
  assert.ok(after.includes("host.terminal"));
  assert.ok(after.includes("ingest.qq"));
  assert.ok(!manifestCapabilities(reg, "u2").includes("host.terminal")); // 其他用户不可见
});

test("Companion heartbeat authToken 校验", () => {
  const reg = new CompanionRegistry();
  const r = reg.register({ userId: "u1", capabilities: ["host.fs.read"], grantedScopes: { fsPaths: [root] } });
  assert.equal(reg.heartbeat("u1", r.authToken), true);
  assert.equal(reg.heartbeat("u1", "wrong"), false);
  assert.equal(reg.hasCapability("u1", "host.fs.read"), true);
  assert.equal(reg.hasCapability("u1", "host.terminal"), false);
});