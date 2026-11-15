import { useSyncExternalStore } from "react";
import { beijingDay } from "@/lib/time-policy";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule() {
  clearTimeout(timer);
  // Next Beijing midnight = today's UTC midnight + 16 hours.
  const midnight = Date.parse(`${beijingDay()}T00:00:00Z`) + 16 * 3_600_000;
  timer = setTimeout(refresh, Math.max(1, midnight - Date.now() + 50));
}

function refresh() {
  listeners.forEach((notify) => notify());
  schedule();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  if (listeners.size === 1) {
    schedule();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
  }
  return () => {
    listeners.delete(notify);
    if (!listeners.size) {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    }
  };
}

/** One shared timer, including when many deadline tags are mounted. */
export function useBeijingDay(): string {
  return useSyncExternalStore(subscribe, beijingDay, beijingDay);
}
