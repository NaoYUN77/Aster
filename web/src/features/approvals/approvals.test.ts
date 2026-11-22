import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalRequestView } from "@/api/approvals";
import { parseServerEvent } from "@/api/events";
import { useApprovalStore } from "@/store/approvals";

function sampleApproval(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    id: "apr_001",
    status: "pending",
    caller: { kind: "subagent", subagentId: "sub_abc123", task: "清理构建缓存" },
    toolName: "bash",
    args: { command: "rm -rf ./dist" },
    rule: "destructive_shell",
    reason: "命中危险 Shell 规则：递归强制删除 (rm -rf)",
    categoryKey: "bash:destructive_shell",
    summary: "bash: rm -rf ./dist",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    resolvedAt: null,
    decisionReason: null,
    ...overrides,
  };
}

describe("approvals SSE parsing and store", () => {
  afterEach(() => {
    useApprovalStore.getState().clear();
  });

  it("parses approval.requested, approval.resolved, and snapshot.pendingApprovals", () => {
    const approval = sampleApproval();
    const req = parseServerEvent("approval.requested", approval);
    expect(req.type).toBe("approval.requested");
    if (req.type === "approval.requested") {
      expect(req.approval.id).toBe("apr_001");
      expect(req.approval.caller.kind).toBe("subagent");
    }

    const res = parseServerEvent("approval.resolved", { ...approval, status: "approved_once" });
    expect(res.type).toBe("approval.resolved");

    const snap = parseServerEvent("snapshot", {
      activeRequest: null,
      queue: [],
      pendingApprovals: [approval],
    });
    expect(snap.type).toBe("snapshot");
    if (snap.type === "snapshot") {
      expect(snap.pendingApprovals).toHaveLength(1);
    }
  });

  it("manages pending queue cleanly on upsert, resolve, and setAll", () => {
    const a1 = sampleApproval({ id: "apr_001" });
    const a2 = sampleApproval({ id: "apr_002", caller: { kind: "main", conversationId: "1" } });

    useApprovalStore.getState().upsert(a1);
    useApprovalStore.getState().upsert(a2);
    expect(useApprovalStore.getState().pending.map((item) => item.id)).toEqual([
      "apr_001",
      "apr_002",
    ]);

    useApprovalStore.getState().remove("apr_001");
    expect(useApprovalStore.getState().pending.map((item) => item.id)).toEqual(["apr_002"]);

    useApprovalStore.getState().setAll([a1, { ...a2, status: "denied" }]);
    expect(useApprovalStore.getState().pending.map((item) => item.id)).toEqual(["apr_001"]);
  });
});
