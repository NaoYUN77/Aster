import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useConnectionStore } from "@/store/connection";
import { refreshConnectorsFromServer } from "./connector-refresh";

type AppStateListener = { remove: () => void | Promise<void> };

type AppStatePlugin = {
  addListener: (
    event: "appStateChange",
    callback: (state: { isActive: boolean }) => void,
  ) => Promise<AppStateListener>;
};

/**
 * 注册“回到前台时重新拉连接器”监听，返回取消函数。
 *
 * 只刷新查询，不关闭系统浏览器、不处理 deep link。独立导出便于测试。
 */
export async function registerConnectorResumeRefresh(options: {
  app: AppStatePlugin;
  queryClient: QueryClient;
  baseUrl: string;
}): Promise<() => void> {
  const listener = await options.app.addListener("appStateChange", (state) => {
    if (!state.isActive) return;
    void refreshConnectorsFromServer(options.queryClient, options.baseUrl);
  });

  return () => {
    void listener.remove();
  };
}

/**
 * 原生 App 从浏览器切回前台（`appStateChange` 的 `isActive: true`）时
 * 重新拉 `GET /api/v1/connectors`，让卡片显示绿色「已连接」。
 *
 * 授权页仍留在浏览器里，是否关闭由用户决定；Web 端不需要注册。
 */
export function useConnectorResumeRefresh(): void {
  const queryClient = useQueryClient();
  const baseUrl = useConnectionStore((state) => state.baseUrl);

  useEffect(() => {
    let cancelled = false;
    let unregister: (() => void) | undefined;

    void (async () => {
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform() || cancelled) return;

      const { App } = await import("@capacitor/app");
      const remove = await registerConnectorResumeRefresh({
        app: App,
        queryClient,
        baseUrl,
      });
      if (cancelled) {
        remove();
        return;
      }
      unregister = remove;
    })().catch(() => {
      // Web 或没有 App 插件时静默降级；页面本身的可见性刷新仍然有效。
    });

    return () => {
      cancelled = true;
      unregister?.();
    };
  }, [queryClient, baseUrl]);
}
