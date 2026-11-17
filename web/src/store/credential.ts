import { create } from "zustand";
import type { CredentialRequest } from "@/api/connectors";

/**
 * 当前待处理的安全注入请求。
 *
 * 只在内存里保存请求元数据（requestId / connector / tool / scopes / 到期时间），
 * 不保存用户输入的 token。请求本身由服务端持有；页面切到后台再回来时
 * 仍能恢复弹窗（MVP 只保证前台恢复，进程被杀后由服务端超时结束）。
 */
type CredentialState = {
  pending: CredentialRequest | null;
  /** 已处理过的 requestId，避免服务端重复推送把弹窗重新打开。 */
  settled: Record<string, number>;
  setPending: (request: CredentialRequest) => void;
  clear: (requestId?: string) => void;
};

const SETTLED_TTL_MS = 10 * 60_000;
const SETTLED_MAX = 20;

function pruneSettled(settled: Record<string, number>): Record<string, number> {
  const cutoff = Date.now() - SETTLED_TTL_MS;
  const entries = Object.keys(settled)
    .filter((id) => settled[id]! >= cutoff)
    .map((id) => [id, settled[id]!] as const)
    .sort((left, right) => right[1] - left[1])
    .slice(0, SETTLED_MAX);
  const next: Record<string, number> = {};
  for (const [id, at] of entries) next[id] = at;
  return next;
}

export const useCredentialStore = create<CredentialState>((set, get) => ({
  pending: null,
  settled: {},

  setPending: (request) => {
    if (get().settled[request.requestId]) return;
    set({ pending: request });
  },

  clear: (requestId) => {
    const current = get().pending;
    const target = requestId ?? current?.requestId;
    if (!target) return;
    if (current && current.requestId !== target) return;
    const settled = pruneSettled({ ...get().settled, [target]: Date.now() });
    set({ pending: null, settled });
  },
}));
