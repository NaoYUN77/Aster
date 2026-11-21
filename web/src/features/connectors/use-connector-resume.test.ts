import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { registerConnectorResumeRefresh } from "./use-connector-resume";

type State = { isActive: boolean };

function fakeApp() {
  const listeners: Array<(state: State) => void> = [];
  const remove = vi.fn();
  const addListener = vi.fn(
    async (
      _event: "appStateChange",
      callback: (state: State) => void,
    ) => {
      listeners.push(callback);
      return { remove };
    },
  );
  return { app: { addListener }, listeners, remove };
}

describe("registerConnectorResumeRefresh", () => {
  it("注册 appStateChange，仅在回到前台时重新拉连接器", async () => {
    const { app, listeners, remove } = fakeApp();
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();

    const unregister = await registerConnectorResumeRefresh({
      app,
      queryClient,
      baseUrl: "https://aster.test",
    });

    expect(app.addListener).toHaveBeenCalledWith(
      "appStateChange",
      expect.any(Function),
    );

    listeners[0]!({ isActive: false });
    expect(invalidate).not.toHaveBeenCalled();

    listeners[0]!({ isActive: true });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["connectors", "https://aster.test"],
    });

    unregister();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
