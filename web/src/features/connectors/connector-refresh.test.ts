import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discardFailedConnector,
  refreshConnectorsFromServer,
} from "./connector-refresh";

const browserClose = vi.hoisted(() => vi.fn());
const deleteConnector = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock("@capacitor/browser", () => ({
  Browser: { open: vi.fn(), close: browserClose },
}));

vi.mock("@/api/connectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/connectors")>();
  return { ...actual, deleteConnector };
});

afterEach(() => {
  browserClose.mockReset();
  deleteConnector.mockReset();
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

describe("discardFailedConnector", () => {
  it("best-effort 删除失败的 pending 行并刷新列表", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    deleteConnector.mockResolvedValue(undefined);

    await discardFailedConnector(
      queryClient,
      "https://aster.test",
      "gmail",
    );

    expect(deleteConnector).toHaveBeenCalledWith("gmail");
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["connectors", "https://aster.test"],
    });
  });

  it("删除失败不抛错，仍刷新列表且不触发浏览器操作", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    deleteConnector.mockRejectedValue(new Error("network"));

    await expect(
      discardFailedConnector(queryClient, "https://aster.test", "github"),
    ).resolves.toBeUndefined();

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(browserClose).not.toHaveBeenCalled();
  });
});
