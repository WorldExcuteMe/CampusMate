import { useEffect, useState } from "react";
import { runtime } from "@/app/config";

export interface DisplayProfile {
  name: string;
  avatarUrl: string;
  custom: boolean;
  setName: (name: string) => void;
  setAvatarUrl: (avatarUrl: string) => void;
  reset: () => void;
}

interface DisplayOverride {
  name?: string;
  avatarUrl?: string;
}

interface PlatformProfile {
  name: string;
  avatarUrl: string;
}

const STORAGE_PREFIX = "campusmate.display:";
const CHANGE_EVENT = "campusmate:display-change";

function storageKey(userId: string) {
  return `${STORAGE_PREFIX}${userId}`;
}

function readOverride(userId: string): DisplayOverride {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(userId)) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeOverride(userId: string, value: DisplayOverride) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(value));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: userId }));
  } catch {
    // 本地存储不可用时仍保持当前会话可用，不阻断聊天。
  }
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function parsePlatformProfile(body: unknown): PlatformProfile {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { name: "", avatarUrl: "" };
  const root = body as Record<string, unknown>;
  const nested = root.profile && typeof root.profile === "object" && !Array.isArray(root.profile)
    ? root.profile as Record<string, unknown>
    : {};
  const user = root.user && typeof root.user === "object" && !Array.isArray(root.user)
    ? root.user as Record<string, unknown>
    : {};
  const merged = { ...nested, ...user, ...root };
  const email = firstText(merged.email);
  return {
    name: firstText(merged.display_name, merged.displayName, merged.nickname, merged.name, merged.username, email ? email.split("@")[0] : ""),
    avatarUrl: firstText(merged.avatar_url, merged.avatarUrl, merged.avatar, merged.picture),
  };
}

export function useDisplayProfile(
  userId: string | undefined,
  fallback: { name?: string; email?: string | null } = {},
): DisplayProfile {
  const [platform, setPlatform] = useState<PlatformProfile>({ name: "", avatarUrl: "" });
  const [override, setOverride] = useState<DisplayOverride>(() => userId ? readOverride(userId) : {});

  useEffect(() => {
    setOverride(userId ? readOverride(userId) : {});
    if (!userId || runtime !== "cloud") {
      setPlatform({ name: "", avatarUrl: "" });
      return;
    }
    let active = true;
    void fetch("/__qoder_auth/me", { credentials: "include", cache: "no-store", headers: { Accept: "application/json" } })
      .then(response => response.ok ? response.json() : null)
      .then(body => { if (active) setPlatform(parsePlatformProfile(body)); })
      .catch(() => { /* 平台未返回资料时使用账号/邮箱回退。 */ });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    const onChange = (event: Event) => {
      if ((event as CustomEvent<string>).detail === userId) setOverride(userId ? readOverride(userId) : {});
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, [userId]);

  const name = firstText(override.name, platform.name, fallback.email ? fallback.email.split("@")[0] : "", fallback.name, "Qoder 用户");
  const avatarUrl = firstText(override.avatarUrl, platform.avatarUrl);

  return {
    name,
    avatarUrl,
    custom: Boolean(override.name || override.avatarUrl),
    setName: (value) => {
      if (!userId) return;
      const next: DisplayOverride = { ...readOverride(userId) };
      if (value.trim()) next.name = value.trim(); else delete next.name;
      writeOverride(userId, next);
    },
    setAvatarUrl: (value) => {
      if (!userId) return;
      const next: DisplayOverride = { ...readOverride(userId) };
      if (value.trim()) next.avatarUrl = value.trim(); else delete next.avatarUrl;
      writeOverride(userId, next);
    },
    reset: () => {
      if (!userId) return;
      writeOverride(userId, {});
    },
  };
}
