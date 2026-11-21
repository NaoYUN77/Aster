/**
 * 三端统一的授权页打开方式：一律交给设备默认浏览器。
 *
 * - Tauri：`@tauri-apps/plugin-opener` 调系统默认浏览器；
 * - Capacitor：`@capacitor/browser` 的 Custom Tabs（Android 跟随默认浏览器）；
 * - Web：新标签页 `window.open(url, "_blank", "noopener,noreferrer")`。
 *
 * 任何情况下都不跳转当前页、不关闭/接管浏览器。Web 端因为带了 `noopener`，
 * `window.open` 无论成功还是被拦截都会返回 null，无法可靠区分；因此 Web 端
 * 统一返回 `"manual"`，由调用方同时渲染一个可手动点击的「打开授权页」链接，
 * 被拦截时用户仍能继续。
 */

export type OpenAuthOutcome = "opened" | "manual";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as TauriWindow).__TAURI_INTERNALS__ !== undefined
  );
}

function openInBrowserTab(url: string): OpenAuthOutcome {
  try {
    if (typeof window !== "undefined" && typeof window.open === "function") {
      // noopener 下返回值按规范恒为 null，不能用来判断是否被拦截；
      // 因此 Web 端一律保留手动链接兜底。
      window.open(url, "_blank", "noopener,noreferrer");
    }
  } catch {
    // 弹窗被拦截或环境不支持；手动链接仍可用。
  }
  return "manual";
}

export async function openAuthUrl(url: string): Promise<OpenAuthOutcome> {
  if (isTauri()) {
    try {
      // 动态 import：浏览器构建不加载 Tauri 包，也不触碰 Tauri API。
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return "opened";
    } catch {
      return "manual";
    }
  }

  const { Capacitor } = await import("@capacitor/core");
  if (Capacitor.isNativePlatform()) {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url });
      return "opened";
    } catch {
      return "manual";
    }
  }

  return openInBrowserTab(url);
}
