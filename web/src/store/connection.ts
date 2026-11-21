import { create } from "zustand";
import { checkHealth, configureApi } from "@/api/client";
import { toApiError } from "@/api/errors";
import { platform } from "@/lib/platform";
import {
  defaultWebBaseUrl,
  normalizeServerUrl,
  validateServerUrl,
} from "@/lib/server-url";
import { storageGet, storageSet } from "@/lib/storage";

export type ConnectionTestResult =
  | { ok: true; version: string; latencyMs: number }
  | { ok: false; message: string };

type ConnectionState = {
  ready: boolean;
  baseUrl: string;
  needsServer: boolean;
  bootstrap: () => Promise<void>;
  saveServerUrl: (input: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  testConnection: (input?: string) => Promise<ConnectionTestResult>;
};

const SERVER_URL_KEY = "serverUrl";

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  ready: false,
  baseUrl: "",
  needsServer: false,

  bootstrap: async () => {
    if (platform() === "web") {
      const baseUrl = defaultWebBaseUrl();
      configureApi({ baseUrl });
      set({ ready: true, baseUrl, needsServer: false });
      return;
    }

    const stored = await storageGet(SERVER_URL_KEY);
    if (stored) {
      const validation = validateServerUrl(stored);
      if (validation.ok) {
        configureApi({ baseUrl: validation.url });
        set({ ready: true, baseUrl: validation.url, needsServer: false });
        return;
      }
    }

    configureApi({ baseUrl: "" });
    set({ ready: true, baseUrl: "", needsServer: true });
  },

  saveServerUrl: async (input) => {
    const validation = validateServerUrl(input);
    if (!validation.ok) return { ok: false, message: validation.message };
    await storageSet(SERVER_URL_KEY, validation.url);
    configureApi({ baseUrl: validation.url });
    set({ baseUrl: validation.url, needsServer: false });
    return { ok: true };
  },

  testConnection: async (input) => {
    const target = input === undefined ? get().baseUrl : normalizeServerUrl(input);
    const validation = validateServerUrl(target);
    if (!validation.ok) return { ok: false, message: validation.message };

    const startedAt = performance.now();
    try {
      const health = await checkHealth(validation.url);
      return {
        ok: true,
        version: health.version,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      return { ok: false, message: toApiError(error).message };
    }
  },
}));
