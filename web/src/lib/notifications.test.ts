import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverNotification, truncateSummary } from "./notifications";
import * as sound from "./sound";
import { useSoundStore } from "@/store/sound";

describe("cross-platform notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useSoundStore.setState({ muted: false });
  });

  it("truncates long bodies safely to 80 chars without newlines", () => {
    const raw = "第一行内容\n\n   " + "A".repeat(120);
    const out = truncateSummary(raw);
    expect(out.includes("\n")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(81);
    expect(out.endsWith("…")).toBe(true);
  });

  it("suppresses completion notifications while app is in foreground", async () => {
    const cueSpy = vi.spyOn(sound, "playCue").mockImplementation(() => {});
    const sent = await deliverNotification({
      priority: "completion",
      cue: "success",
      title: "Aster 已回复",
      body: "已完成",
      systemEnabled: true,
      permission: "granted",
      foregroundOverride: true,
    });
    expect(sent).toBe(false);
    expect(cueSpy).not.toHaveBeenCalled();
  });

  it("plays Web Audio cue only (no system popup) for high-priority events in foreground", async () => {
    const cueSpy = vi.spyOn(sound, "playCue").mockImplementation(() => {});
    const sent = await deliverNotification({
      priority: "high",
      cue: "attention",
      title: "需要你审批",
      body: "Main Agent · bash",
      systemEnabled: true,
      permission: "granted",
      foregroundOverride: true,
    });
    expect(sent).toBe(false);
    expect(cueSpy).toHaveBeenCalledWith("attention");
  });

  it("dispatches silent Web Notification + Web Audio cue when backgrounded (prevents double sound)", async () => {
    const cueSpy = vi.spyOn(sound, "playCue").mockImplementation(() => {});
    const notifCtor = vi.fn();
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(title: string, opts?: NotificationOptions) {
        notifCtor(title, opts);
      }
    }
    vi.stubGlobal("window", { Notification: FakeNotification, focus: vi.fn() });
    vi.stubGlobal("Notification", FakeNotification);

    const sent = await deliverNotification({
      priority: "high",
      cue: "attention",
      title: "需要你审批",
      body: "Main Agent · bash",
      tag: "approval:1",
      systemEnabled: true,
      permission: "granted",
      foregroundOverride: false,
    });

    expect(sent).toBe(true);
    expect(cueSpy).toHaveBeenCalledWith("attention");
    expect(notifCtor).toHaveBeenCalledWith("需要你审批", {
      body: "Main Agent · bash",
      silent: true,
      tag: "approval:1",
    });
  });
});
