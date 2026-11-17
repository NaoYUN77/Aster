import { create } from "zustand";
import { configureApi, login as loginRequest, logout as logoutRequest, me } from "@/api/client";
import { ApiError, toApiError } from "@/api/errors";
import { storageGet, storageRemove, storageSet } from "@/lib/storage";

export type AuthStatus = "loading" | "anonymous" | "authenticated";

type AuthState = {
  status: AuthStatus;
  token: string | null;
  ownerId: string | null;
  expiresAt: number | null;
  bootstrap: () => Promise<void>;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  invalidate: () => Promise<void>;
};

const TOKEN_KEY = "token";
const EXPIRES_KEY = "expiresAt";

/** 契约里的 expiresAt 是 ISO 时间串；本地统一存 epoch 毫秒用于展示。 */
function parseExpiresAt(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function clearCredentials(token: string | null): Promise<void> {
  await storageRemove(TOKEN_KEY);
  await storageRemove(EXPIRES_KEY);
  if (token) {
    try {
      await logoutRequest();
    } catch {
      /* 本地已清除；服务端 token 会自然过期 */
    }
  }
  configureApi({ token: null });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: "loading",
  token: null,
  ownerId: null,
  expiresAt: null,

  bootstrap: async () => {
    const token = await storageGet(TOKEN_KEY);
    if (!token) {
      set({ status: "anonymous", token: null, ownerId: null, expiresAt: null });
      return;
    }

    const expiresRaw = await storageGet(EXPIRES_KEY);
    const storedExpiry = parseExpiresAt(expiresRaw);

    configureApi({ token });
    set({
      token,
      expiresAt: storedExpiry && Number.isFinite(storedExpiry) ? storedExpiry : null,
    });

    try {
      const info = await me();
      await storageSet(EXPIRES_KEY, info.expiresAt);
      set({
        status: "authenticated",
        ownerId: info.ownerId,
        expiresAt: parseExpiresAt(info.expiresAt),
      });
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError instanceof ApiError && apiError.status === 401) {
        await storageRemove(TOKEN_KEY);
        await storageRemove(EXPIRES_KEY);
        configureApi({ token: null });
        set({ status: "anonymous", token: null, ownerId: null, expiresAt: null });
        return;
      }
      // 网络不可用时保留本地会话，聊天页会显示连接状态与重试。
      set({ status: "authenticated", ownerId: "owner" });
    }
  },

  login: async (password) => {
    const session = await loginRequest(password);
    configureApi({ token: session.token });
    await storageSet(TOKEN_KEY, session.token);
    await storageSet(EXPIRES_KEY, session.expiresAt);
    set({
      status: "authenticated",
      token: session.token,
      ownerId: null,
      expiresAt: parseExpiresAt(session.expiresAt),
    });

    try {
      const info = await me();
      set({ ownerId: info.ownerId, expiresAt: parseExpiresAt(info.expiresAt) });
    } catch {
      /* /auth/me 失败不阻止进入聊天，SSE/查询会继续报告连接问题 */
    }
  },

  logout: async () => {
    const token = get().token;
    await clearCredentials(token);
    set({ status: "anonymous", token: null, ownerId: null, expiresAt: null });
  },

  invalidate: async () => {
    await storageRemove(TOKEN_KEY);
    await storageRemove(EXPIRES_KEY);
    configureApi({ token: null });
    set({ status: "anonymous", token: null, ownerId: null, expiresAt: null });
  },
}));
