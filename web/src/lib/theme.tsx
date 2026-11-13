import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type StepDensity = "compact" | "standard" | "detailed";
export interface Appearance {
  theme: ThemeMode;
  fontSize: number;
  stepDensity: StepDensity;
  language: "zh" | "en";
}

const KEY = "campusmate.appearance";
const DEFAULT: Appearance = { theme: "dark", fontSize: 14, stepDensity: "standard", language: "zh" };

function load(): Appearance {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return DEFAULT;
  }
}
function resolve(theme: ThemeMode): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

interface AppearanceCtx {
  appearance: Appearance;
  resolved: "light" | "dark";
  setAppearance: (p: Partial<Appearance>) => void;
}
const Ctx = createContext<AppearanceCtx>({ appearance: DEFAULT, resolved: "dark", setAppearance: () => {} });

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setA] = useState<Appearance>(load);
  const [resolved, setResolved] = useState<"light" | "dark">(() => resolve(load().theme));

  useEffect(() => {
    const apply = () => {
      const r = resolve(appearance.theme);
      setResolved(r);
      const el = document.documentElement;
      el.dataset.theme = r;
      el.dataset.density = appearance.stepDensity;
      el.style.fontSize = `${appearance.fontSize}px`;
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (appearance.theme === "system") apply(); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [appearance]);

  const setAppearance = (p: Partial<Appearance>) =>
    setA((prev) => {
      const next = { ...prev, ...p };
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });

  return <Ctx.Provider value={{ appearance, resolved, setAppearance }}>{children}</Ctx.Provider>;
}

export const useAppearance = () => useContext(Ctx);