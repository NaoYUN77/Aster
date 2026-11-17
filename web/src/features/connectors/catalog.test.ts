import { describe, expect, it } from "vitest";
import type { Connector } from "@/api/connectors";
import { mergeCatalog } from "./catalog";

function remote(overrides: Partial<Connector> & Pick<Connector, "id">): Connector {
  return {
    name: "X",
    description: "d",
    status: "disconnected",
    account: null,
    scopes: [],
    readOnly: false,
    connectedAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("mergeCatalog", () => {
  it("始终只展示 GitHub / Gmail，并补齐缺失项", () => {
    const merged = mergeCatalog([]);
    expect(merged.map((connector) => connector.id)).toEqual(["github", "gmail"]);
    expect(merged.every((connector) => connector.status === "disconnected")).toBe(true);
  });

  it("以服务端状态为准，但 Gmail 保持只读", () => {
    const merged = mergeCatalog([
      remote({
        id: "gmail",
        name: "Gmail",
        status: "connected",
        readOnly: false,
        account: { id: "a@b.c", label: "a@b.c" },
        scopes: ["gmail.readonly"],
        connectedAt: "2026-01-01T00:00:00.000Z",
      }),
      remote({ id: "slack" as Connector["id"], status: "connected" }),
    ]);

    const gmail = merged.find((connector) => connector.id === "gmail");
    expect(gmail?.status).toBe("connected");
    expect(gmail?.readOnly).toBe(true);
    expect(gmail?.account?.label).toBe("a@b.c");
    expect(merged.some((connector) => (connector.id as string) === "slack")).toBe(false);
  });
});
