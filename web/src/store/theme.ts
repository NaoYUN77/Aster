import { create } from "zustand";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "aster.theme";

function readStoredTheme(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* 隐私模式或旧 WebView 忽略存储错误 */
  }
  return "light";
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "light" || mode === "dark") return mode;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

function applyDomTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", resolved === "dark" ? "#000000" : "#ffffff");
  }
}

type ThemeState = {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
};

const initialMode: ThemeMode =
  typeof window !== "undefined" ? readStoredTheme() : "light";
const initialResolved: ResolvedTheme = resolveTheme(initialMode);

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: initialMode,
  resolved: initialResolved,

  setMode: (mode) => {
    const resolved = resolveTheme(mode);
    applyDomTheme(resolved);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
    set({ mode, resolved });
  },

  toggle: () => {
    const next: ThemeMode = get().resolved === "dark" ? "light" : "dark";
    get().setMode(next);
  },
}));

/** 启动时应用已保存的主题（默认浅色），并监听系统配色变更。 */
export function initTheme(): void {
  const { mode, resolved } = useThemeStore.getState();
  applyDomTheme(resolved);
  if (typeof window === "undefined" || !window.matchMedia) return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (useThemeStore.getState().mode === "system") {
      const next = resolveTheme("system");
      applyDomTheme(next);
      useThemeStore.setState({ resolved: next });
    }
  };
  if (mode === "system") onChange();
  media.addEventListener("change", onChange);
}
