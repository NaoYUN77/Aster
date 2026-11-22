import { afterEach, describe, expect, it, vi } from "vitest";
import { parseServerEvent } from "@/api/events";
import type { SubagentSnapshot } from "@/api/subagents";
import { deriveCompanionMode } from "./CompanionSprite";
import { isSubagentActive, useSubagentStore } from "@/store/subagents";

function sampleSubagent(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sub_001",
    task: "巡检 workspace 文件结构并汇总",
    status: "running",
    currentTool: "read",
    startedAt: Date.now() - 5_000,
    finishedAt: null,
    ...overrides,
  };
}

describe("Sub-agent status store, SSE parsing, and companion mode", () => {
  afterEach(() => {
    vi.useRealTimers();
    useSubagentStore.getState().clear();
  });

  it("parses subagent.updated and snapshot.activeSubagents", () => {
    const sub = sampleSubagent();
    const updated = parseServerEvent("subagent.updated", sub);
    expect(updated.type).toBe("subagent.updated");
    if (updated.type === "subagent.updated") {
      expect(updated.subagent.id).toBe("sub_001");
      expect(updated.subagent.currentTool).toBe("read");
    }

    const snap = parseServerEvent("snapshot", {
      activeRequest: null,
      queue: [],
      activeSubagents: [sub],
    });
    expect(snap.type).toBe("snapshot");
    if (snap.type === "snapshot") {
      expect(snap.activeSubagents).toHaveLength(1);
    }
  });

  it("lingers for 3 seconds after all sub-agents complete and clears automatically", () => {
    vi.useFakeTimers();
    const sub = sampleSubagent();
    useSubagentStore.getState().upsert(sub);
    expect(useSubagentStore.getState().items.filter(isSubagentActive)).toHaveLength(1);

    useSubagentStore.getState().upsert({
      ...sub,
      status: "completed",
      currentTool: null,
      finishedAt: Date.now(),
    });
    expect(useSubagentStore.getState().items).toHaveLength(1);

    vi.advanceTimersByTime(2_900);
    expect(useSubagentStore.getState().items).toHaveLength(1);

    vi.advanceTimersByTime(200);
    expect(useSubagentStore.getState().items).toHaveLength(0);
  });

  it("keeps the 3D companion in working/busy mode while any sub-agent is active", () => {
    expect(deriveCompanionMode(null, 0, 0)).toBe("idle");
    expect(deriveCompanionMode(null, 0, 1)).toBe("working");
    expect(deriveCompanionMode(null, 2, 1)).toBe("busy");
  });
});
