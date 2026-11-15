const PREFIX = "campusmate.group.seen.v2.";

/** Scope comes from the repository instance, never the model, title or mutable profile. */
export function groupSeenKey(scope: string): string {
  if (typeof scope !== "string" || !scope.trim()) throw new Error("缺少稳定的账号作用域，无法同步群通知");
  return `${PREFIX}${encodeURIComponent(scope)}`;
}

export function readGroupSeen(key: string): string[] {
  // The old global key has no known owner. Do not read, migrate or delete it here.
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(-500) : [];
  } catch {
    return [];
  }
}
