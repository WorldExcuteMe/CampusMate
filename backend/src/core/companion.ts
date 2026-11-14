// Local Companion 注册表 + 授权范围强制。本机能力（terminal/fs/QQ/微信）仅经 Companion，
// 云端默认 Manifest 不含；授权范围（fsPaths/qqGroups/terminalAllowlist）服务端强制，越界拒绝。
import { randomUUID } from "node:crypto";
import path from "node:path";

export type CompanionCapability = "host.terminal" | "host.fs.read" | "host.fs.write" | "ingest.qq" | "ingest.wechat";

export interface GrantedScopes {
  fsPaths?: string[];          // 允许读写的目录前缀（绝对路径）
  qqGroups?: string[];         // 允许摄取的群 uin
  terminalAllowlist?: string[]; // 允许的命令前缀
}

export interface CompanionRegistration {
  userId: string;
  deviceId: string;
  capabilities: CompanionCapability[];
  grantedScopes: GrantedScopes;
  authToken: string;
  lastHeartbeat: number;
}

export interface ScopeCheck { ok: boolean; reason?: string; }

// 路径授权：规范化后必须落在某个授权目录前缀内（防 ../ 逃逸）。
export function checkFsPath(scopes: GrantedScopes, target: string, write: boolean): ScopeCheck {
  const roots = scopes.fsPaths ?? [];
  if (!roots.length) return { ok: false, reason: "未授权任何文件路径" };
  const norm = path.resolve(target);
  const allowed = roots.some((r) => {
    const root = path.resolve(r);
    return norm === root || norm.startsWith(root + path.sep);
  });
  if (!allowed) return { ok: false, reason: `路径越界：${target} 不在授权目录内` };
  if (write && !(scopes.fsPaths ?? []).length) return { ok: false, reason: "未授权写" };
  return { ok: true };
}

// 命令授权：必须匹配白名单前缀（按词边界，防 ls;rm 拼接）。
export function checkTerminal(scopes: GrantedScopes, command: string): ScopeCheck {
  const allow = scopes.terminalAllowlist ?? [];
  if (!allow.length) return { ok: false, reason: "未授权任何终端命令" };
  const cmd = command.trim();
  const ok = allow.some((prefix) => cmd === prefix || cmd.startsWith(prefix + " "));
  if (!ok) return { ok: false, reason: `命令越界：${cmd.slice(0, 40)} 不在白名单` };
  if (/[;&|`$]|\n/.test(cmd)) return { ok: false, reason: "命令含 shell 元字符，拒绝（防拼接注入）" };
  return { ok: true };
}

// 群授权：指定群必须在授权列表；省略时若仅授权一个群则用之，否则拒绝（不默认全群）。
export function checkGroup(scopes: GrantedScopes, group: string | undefined): ScopeCheck & { group?: string } {
  const groups = scopes.qqGroups ?? [];
  if (!groups.length) return { ok: false, reason: "未授权任何群" };
  if (!group) {
    if (groups.length === 1) return { ok: true, group: groups[0] };
    return { ok: false, reason: "需指定群（授权多个群时不默认全群）" };
  }
  if (!groups.includes(group)) return { ok: false, reason: `群越界：${group} 不在授权列表` };
  return { ok: true, group };
}

export class CompanionRegistry {
  private byUser = new Map<string, CompanionRegistration>();

  register(input: { userId: string; deviceId?: string; capabilities: CompanionCapability[]; grantedScopes: GrantedScopes }): CompanionRegistration {
    const reg: CompanionRegistration = {
      userId: input.userId,
      deviceId: input.deviceId ?? randomUUID(),
      capabilities: input.capabilities,
      grantedScopes: input.grantedScopes,
      authToken: randomUUID(),
      lastHeartbeat: Date.now(),
    };
    this.byUser.set(input.userId, reg);
    return reg;
  }
  heartbeat(userId: string, authToken: string): boolean {
    const r = this.byUser.get(userId);
    if (!r || r.authToken !== authToken) return false;
    r.lastHeartbeat = Date.now();
    return true;
  }
  resolve(userId: string): CompanionRegistration | null { return this.byUser.get(userId) ?? null; }
  hasCapability(userId: string, cap: CompanionCapability): boolean {
    return this.byUser.get(userId)?.capabilities.includes(cap) ?? false;
  }
  unregister(userId: string): void { this.byUser.delete(userId); }
}

// 云端 Manifest 默认能力（不含任何 host.*/ingest.*）。Companion 注册后才叠加该用户授权能力。
export const CLOUD_DEFAULT_CAPABILITIES = ["llm.chat", "web.fetch", "web.search", "rag.search", "db.read", "db.write_user"] as const;

export function manifestCapabilities(reg: CompanionRegistry, userId: string): string[] {
  const caps: string[] = [...CLOUD_DEFAULT_CAPABILITIES];
  const r = reg.resolve(userId);
  if (r) caps.push(...r.capabilities);
  return caps;
}