export type Platform = "web" | "tauri" | "capacitor";

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isCapacitor(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

export function platform(): Platform {
  if (isTauri()) return "tauri";
  if (isCapacitor()) return "capacitor";
  return "web";
}

export function isNative(): boolean {
  return platform() !== "web";
}

export function platformLabel(): string {
  switch (platform()) {
    case "tauri":
      return "桌面端";
    case "capacitor":
      return "移动端";
    default:
      return "Web";
  }
}
