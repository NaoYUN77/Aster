import { isCapacitor, isTauri } from "./platform";

/**
 * Token 与服务器地址的跨端存储。
 *
 * - Web: localStorage（单 owner + 严格 CSP + 无第三方脚本）。
 * - Tauri: tauri-plugin-store（不把 token 明文写进普通文件系统路径）。
 * - Capacitor: @capacitor/preferences。
 *
 * 所有实现都是异步的，UI 在 bootstrap 完成前显示启动占位。
 */

const WEB_PREFIX = "aster.";

async function tauriStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load("settings.json", { autoSave: true, defaults: {} });
}

async function capacitorPreferences() {
  const { Preferences } = await import("@capacitor/preferences");
  return Preferences;
}

export async function storageGet(key: string): Promise<string | null> {
  try {
    if (isTauri()) {
      const store = await tauriStore();
      return (await store.get<string>(key)) ?? null;
    }
    if (isCapacitor()) {
      const preferences = await capacitorPreferences();
      const { value } = await preferences.get({ key });
      return value ?? null;
    }
    return window.localStorage.getItem(WEB_PREFIX + key);
  } catch {
    return null;
  }
}

export async function storageSet(key: string, value: string): Promise<void> {
  if (isTauri()) {
    const store = await tauriStore();
    await store.set(key, value);
    await store.save();
    return;
  }
  if (isCapacitor()) {
    const preferences = await capacitorPreferences();
    await preferences.set({ key, value });
    return;
  }
  window.localStorage.setItem(WEB_PREFIX + key, value);
}

export async function storageRemove(key: string): Promise<void> {
  if (isTauri()) {
    const store = await tauriStore();
    await store.delete(key);
    await store.save();
    return;
  }
  if (isCapacitor()) {
    const preferences = await capacitorPreferences();
    await preferences.remove({ key });
    return;
  }
  window.localStorage.removeItem(WEB_PREFIX + key);
}
