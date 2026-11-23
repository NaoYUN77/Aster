import { create } from "zustand";
import {
  checkNotificationPermission,
  deliverNotification,
  requestNotificationPermission,
  type NotificationPermissionState,
  type NotifyPayload,
} from "@/lib/notifications";
import { storageGet, storageSet } from "@/lib/storage";

const ENABLED_KEY = "notifyEnabled";
const BANNER_DISMISSED_KEY = "notifyBannerDismissed";
const KEEP_ALIVE_KEY = "notifyKeepAlive";

type NotificationState = {
  enabled: boolean;
  keepAliveEnabled: boolean;
  permission: NotificationPermissionState;
  bannerDismissed: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  refreshPermission: () => Promise<NotificationPermissionState>;
  requestPermission: () => Promise<NotificationPermissionState>;
  setEnabled: (enabled: boolean) => void;
  setKeepAliveEnabled: (enabled: boolean) => void;
  dismissBanner: () => void;
  notify: (payload: NotifyPayload) => Promise<boolean>;
};

export const useNotificationStore = create<NotificationState>((set, get) => ({
  enabled: true,
  keepAliveEnabled: true,
  permission: "default",
  bannerDismissed: false,
  hydrated: false,

  hydrate: async () => {
    const [rawEnabled, rawDismissed, rawKeepAlive, permission] = await Promise.all([
      storageGet(ENABLED_KEY),
      storageGet(BANNER_DISMISSED_KEY),
      storageGet(KEEP_ALIVE_KEY),
      checkNotificationPermission(),
    ]);
    set({
      enabled: rawEnabled !== "0",
      keepAliveEnabled: rawKeepAlive !== "0",
      bannerDismissed: rawDismissed === "1",
      permission,
      hydrated: true,
    });
  },

  refreshPermission: async () => {
    const permission = await checkNotificationPermission();
    set({ permission });
    return permission;
  },

  requestPermission: async () => {
    const permission = await requestNotificationPermission();
    const granted = permission === "granted";
    set({
      permission,
      ...(granted ? { enabled: true, bannerDismissed: true } : {}),
    });
    if (granted) {
      void storageSet(ENABLED_KEY, "1");
      void storageSet(BANNER_DISMISSED_KEY, "1");
    }
    return permission;
  },

  setEnabled: (enabled) => {
    set({ enabled });
    void storageSet(ENABLED_KEY, enabled ? "1" : "0");
  },

  setKeepAliveEnabled: (keepAliveEnabled) => {
    set({ keepAliveEnabled });
    void storageSet(KEEP_ALIVE_KEY, keepAliveEnabled ? "1" : "0");
  },

  dismissBanner: () => {
    set({ bannerDismissed: true });
    void storageSet(BANNER_DISMISSED_KEY, "1");
  },

  notify: async (payload) => {
    const { enabled, permission } = get();
    return deliverNotification({
      ...payload,
      systemEnabled: enabled,
      permission,
    });
  },
}));
