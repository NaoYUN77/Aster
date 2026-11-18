import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshConnectorsFromServer } from "./connector-refresh";

const browserClose = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock("@capacitor/browser", () => ({
  Browser: { open: vi.fn(), close: browserClose },
}));

afterEach(() => {
  browserClose.mockReset();
});

describe("refreshConnectorsFromServer", () => {
  it("只失效 Connectors 查询，绝不关闭系统浏览器", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();

    await refreshConnectorsFromServer(queryClient, "https://aster.test");

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["connectors", "https://aster.test"],
    });
    expect(browserClose).not.toHaveBeenCalled();
  });
});
