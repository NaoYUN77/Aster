import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAuthUrl } from "./open-auth-url";

const native = vi.hoisted(() => ({ value: false }));
const tauriOpenUrl = vi.hoisted(() => vi.fn());
const browserOpen = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.value },
}));
vi.mock("@capacitor/browser", () => ({
  Browser: { open: browserOpen },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: tauriOpenUrl,
}));

const AUTH_URL = "https://github.com/login/oauth/authorize?state=x";

beforeEach(() => {
  native.value = false;
  tauriOpenUrl.mockReset();
  browserOpen.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openAuthUrl", () => {
  it("Web：新标签页打开，参数为 _blank + noopener,noreferrer，并保留手动兜底", async () => {
    const open = vi.fn(() => ({}));
    vi.stubGlobal("window", { open });

    await expect(openAuthUrl(AUTH_URL)).resolves.toBe("manual");
    expect(open).toHaveBeenCalledWith(
      AUTH_URL,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("Web：弹窗被拦截（返回 null）也不跳转当前页，仍可手动打开", async () => {
    const open = vi.fn(() => null);
    const assign = vi.fn();
    vi.stubGlobal("window", { open, location: { assign } });

    await expect(openAuthUrl(AUTH_URL)).resolves.toBe("manual");
    expect(assign).not.toHaveBeenCalled();
  });

  it("Tauri：走 plugin-opener，不碰 window.open", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, open });
    tauriOpenUrl.mockResolvedValue(undefined);

    await expect(openAuthUrl(AUTH_URL)).resolves.toBe("opened");
    expect(tauriOpenUrl).toHaveBeenCalledWith(AUTH_URL);
    expect(open).not.toHaveBeenCalled();
  });

  it("Capacitor：走 Browser.open（Custom Tabs）", async () => {
    native.value = true;
    browserOpen.mockResolvedValue(undefined);

    await expect(openAuthUrl(AUTH_URL)).resolves.toBe("opened");
    expect(browserOpen).toHaveBeenCalledWith({ url: AUTH_URL });
  });
});
