import { isCapacitor, isTauri } from "./platform";
import { playCue, type SoundCue } from "./sound";
import { useSoundStore } from "@/store/sound";

export type NotificationPermissionState = "default" | "granted" | "denied" | "unsupported";

export type NotifyPayload = {
  /** high: 审批/定时提醒/凭据（前台出声、后台弹系统通知）；completion: 回复/子任务结束（仅后台提醒）。 */
  priority: "high" | "completion";
  cue: SoundCue;
  title: string;
  body: string;
  tag?: string;
  /** 设置页「发送测试通知」使用：即使在前台也强制弹出一条系统通知。 */
  forceSystem?: boolean;
};

const MAX_SUMMARY_CHARS = 80;
const ANDROID_CHANNEL_SOUND = "aster_alerts";
const ANDROID_CHANNEL_SILENT = "aster_alerts_silent";

let nextLocalNotificationId = 1000;
let androidChannelsReady = false;
let focusHandler: (() => void) | null = null;

/** 隐私安全截断：清理多余换行，只保留前 80 字用于系统弹窗/锁屏预览。 */
export function truncateSummary(text: string, maxChars = MAX_SUMMARY_CHARS): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}…`;
}

/** 窗口处于可见且获焦状态视为前台。 */
export function isAppInForeground(): boolean {
  if (typeof document === "undefined") return true;
  if (document.visibilityState !== "visible") return false;
  if (typeof document.hasFocus === "function") return document.hasFocus();
  return true;
}

export function setNotificationFocusHandler(handler: (() => void) | null): void {
  focusHandler = handler;
}

async function bringToForeground(): Promise<void> {
  focusHandler?.();
  if (typeof window !== "undefined") {
    try {
      window.focus();
    } catch {
      /* ignore */
    }
  }
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.show().catch(() => undefined);
      await win.unminimize().catch(() => undefined);
      await win.setFocus().catch(() => undefined);
    } catch {
      /* ignore */
    }
  }
}

async function ensureAndroidChannels(): Promise<void> {
  if (!isCapacitor() || androidChannelsReady) return;
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    await LocalNotifications.createChannel({
      id: ANDROID_CHANNEL_SOUND,
      name: "Aster 提醒",
      description: "敏感操作审批、定时提醒与后台任务通知",
      importance: 5,
      visibility: 0,
      vibration: true,
    });
    await LocalNotifications.createChannel({
      id: ANDROID_CHANNEL_SILENT,
      name: "Aster 静音提醒",
      description: "静音模式下的系统通知",
      importance: 4,
      visibility: 0,
      sound: undefined,
      vibration: false,
    });
    androidChannelsReady = true;
  } catch {
    /* ignore on unsupported platforms */
  }
}

/** 启动原生通知点击监听（Android 点击通知切回主对话页）。 */
export function initNotificationListeners(onOpenChat: () => void): () => void {
  setNotificationFocusHandler(onOpenChat);
  if (!isCapacitor()) {
    return () => setNotificationFocusHandler(null);
  }

  let removeHandle: { remove: () => Promise<void> } | null = null;
  let disposed = false;

  void (async () => {
    await ensureAndroidChannels();
    try {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const handle = await LocalNotifications.addListener(
        "localNotificationActionPerformed",
        () => {
          void bringToForeground();
        },
      );
      if (disposed) {
        void handle.remove();
      } else {
        removeHandle = handle;
      }
    } catch {
      /* ignore */
    }
  })();

  return () => {
    disposed = true;
    setNotificationFocusHandler(null);
    void removeHandle?.remove();
  };
}

export async function checkNotificationPermission(): Promise<NotificationPermissionState> {
  if (isTauri()) {
    try {
      const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
      return (await isPermissionGranted()) ? "granted" : "default";
    } catch {
      return "unsupported";
    }
  }

  if (isCapacitor()) {
    try {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const status = await LocalNotifications.checkPermissions();
      if (status.display === "granted") return "granted";
      if (status.display === "denied") return "denied";
      return "default";
    } catch {
      return "unsupported";
    }
  }

  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  const perm = window.Notification.permission;
  return perm === "granted" || perm === "denied" ? perm : "default";
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (isTauri()) {
    try {
      const { isPermissionGranted, requestPermission } = await import(
        "@tauri-apps/plugin-notification"
      );
      if (await isPermissionGranted()) return "granted";
      const result = await requestPermission();
      return result === "granted" ? "granted" : "denied";
    } catch {
      return "unsupported";
    }
  }

  if (isCapacitor()) {
    try {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      await ensureAndroidChannels();
      const result = await LocalNotifications.requestPermissions();
      if (result.display === "granted") return "granted";
      if (result.display === "denied") return "denied";
      return "default";
    } catch {
      return "unsupported";
    }
  }

  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  try {
    const result = await window.Notification.requestPermission();
    return result === "granted" || result === "denied" ? result : "default";
  } catch {
    return "denied";
  }
}

async function dispatchNativeSystemNotification(
  title: string,
  body: string,
  tag: string | undefined,
  muted: boolean,
): Promise<boolean> {
  if (isTauri()) {
    try {
      const { isPermissionGranted, sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      if (!(await isPermissionGranted())) return false;
      sendNotification({
        title,
        body,
        ...(muted ? {} : { sound: "default" }),
      });
      return true;
    } catch {
      return false;
    }
  }

  if (isCapacitor()) {
    try {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      await ensureAndroidChannels();
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== "granted") return false;
      const id = nextLocalNotificationId++;
      await LocalNotifications.schedule({
        notifications: [
          {
            id,
            title,
            body,
            channelId: muted ? ANDROID_CHANNEL_SILENT : ANDROID_CHANNEL_SOUND,
          },
        ],
      });
      return true;
    } catch {
      return false;
    }
  }

  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }
  if (window.Notification.permission !== "granted") return false;
  try {
    // Web 端统一由 Aster Web Audio 出声，浏览器 Notification 设 silent: true 避免双响。
    const notification = new window.Notification(title, {
      body,
      silent: true,
      ...(tag ? { tag } : {}),
    });
    notification.onclick = () => {
      notification.close();
      void bringToForeground();
    };
    return true;
  } catch {
    return false;
  }
}

export type NotifyOptions = NotifyPayload & {
  systemEnabled: boolean;
  permission: NotificationPermissionState;
  /** 测试注入；默认使用真实前后台判定。 */
  foregroundOverride?: boolean;
};

/**
 * 统一三端提醒分发（方案 A：防双响 + 隐私截断）：
 * - 前台：high 播放 Web Audio 合成音效，completion 静默不打扰；
 * - 后台（或 forceSystem）：
 *   - Web：播 Web Audio + 静音系统通知；
 *   - Windows / Android：系统原生通知自带声源（全局静音时切静音通道），不再叠加 Web Audio。
 */
export async function deliverNotification(options: NotifyOptions): Promise<boolean> {
  const foreground = options.foregroundOverride ?? isAppInForeground();
  const forceSystem = options.forceSystem === true;

  if (foreground && !forceSystem) {
    if (options.priority === "high") {
      playCue(options.cue);
    }
    return false;
  }

  const safeBody = truncateSummary(options.body);
  const canSystem = options.systemEnabled && options.permission === "granted";
  const muted = useSoundStore.getState().muted;

  if (!canSystem) {
    // 未开系统通知权限时，Web/桌面仍尽量给声音提示（Android 后台 WebView 可能被系统冻结）。
    playCue(options.cue);
    return false;
  }

  const isNativeShell = isTauri() || isCapacitor();
  if (!isNativeShell) {
    playCue(options.cue);
  }

  const sent = await dispatchNativeSystemNotification(
    options.title,
    safeBody,
    options.tag,
    muted,
  );
  if (!sent && isNativeShell) {
    playCue(options.cue);
  }
  return sent;
}
