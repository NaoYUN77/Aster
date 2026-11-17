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

/** Preferences 在部分 ROM/WebView 上可能一直不回调，超时后本次会话改用 localStorage。 */
const PREFERENCES_TIMEOUT_MS = 1_500;
let capacitorFallback = false;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("storage-timeout")), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function tauriStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load("settings.json", { autoSave: true, defaults: {} });
}

async function capacitorPreferences() {
  const { Preferences } = await import("@capacitor/preferences");
  return Preferences;
}

async function preferencesGet(key: string): Promise<string | null> {
  const preferences = await capacitorPreferences();
  const { value } = await preferences.get({ key });
  return value ?? null;
}

async function preferencesSet(key: string, value: string): Promise<void> {
  const preferences = await capacitorPreferences();
  await preferences.set({ key, value });
}

async function preferencesRemove(key: string): Promise<void> {
  const preferences = await capacitorPreferences();
  await preferences.remove({ key });
}

export async function storageGet(key: string): Promise<string | null> {
  try {
    if (isTauri()) {
      const store = await tauriStore();
      return (await store.get<string>(key)) ?? null;
    }
    if (isCapacitor()) {
      if (!capacitorFallback) {
        try {
          const value = await withTimeout(preferencesGet(key), PREFERENCES_TIMEOUT_MS);
          if (value !== null) return value;
        } catch {
          capacitorFallback = true;
        }
      }
      // Preferences 超时/报错，或没有值时，回退到 localStorage（可能存着上次回退写入的数据）。
      return window.localStorage.getItem(WEB_PREFIX + key);
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
    if (!capacitorFallback) {
      try {
        await withTimeout(preferencesSet(key, value), PREFERENCES_TIMEOUT_MS);
        return;
      } catch {
        capacitorFallback = true;
      }
    }
    window.localStorage.setItem(WEB_PREFIX + key, value);
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
    if (!capacitorFallback) {
      try {
        await withTimeout(preferencesRemove(key), PREFERENCES_TIMEOUT_MS);
      } catch {
        capacitorFallback = true;
      }
    }
    // 始终清掉回退副本，避免 Preferences 删除失败后旧 token 又被读出来。
    window.localStorage.removeItem(WEB_PREFIX + key);
    return;
  }
  window.localStorage.removeItem(WEB_PREFIX + key);
}
