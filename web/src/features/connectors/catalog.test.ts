import { describe, expect, it } from "vitest";
import type { Connector } from "@/api/connectors";
import {
  CONNECTOR_CATALOG,
  connectorMeta,
  mergeCatalog,
} from "./catalog";

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

describe("catalog", () => {
  it("七个 provider 都有 meta，只读标记正确", () => {
    expect(CONNECTOR_CATALOG.map((meta) => meta.id)).toEqual([
      "github",
      "gmail",
      "outlook",
      "linear",
      "notion",
      "google_calendar",
      "google_drive",
    ]);
    for (const meta of CONNECTOR_CATALOG) {
      expect(connectorMeta(meta.id)).toBe(meta);
      expect(meta.permissions.length).toBeGreaterThan(0);
    }
    expect(connectorMeta("github")?.readOnly).toBe(false);
    expect(connectorMeta("gmail")?.readOnly).toBe(true);
    expect(connectorMeta("outlook")?.readOnly).toBe(true);
    expect(connectorMeta("linear")?.readOnly).toBe(true);
    expect(connectorMeta("notion")?.readOnly).toBe(true);
    expect(connectorMeta("google_calendar")?.readOnly).toBe(true);
    expect(connectorMeta("google_drive")?.readOnly).toBe(true);
  });

  it("Notion / Calendar / Drive 的文案与权限", () => {
    expect(connectorMeta("notion")).toMatchObject({
      name: "Notion",
      tagline: "只读页面与数据库",
      permissions: ["搜索页面/数据库", "读取页面内容"],
    });
    expect(connectorMeta("google_calendar")).toMatchObject({
      name: "Google Calendar",
      tagline: "只读日历事件",
      permissions: ["读取日历与事件"],
    });
    expect(connectorMeta("google_drive")).toMatchObject({
      name: "Google Drive",
      tagline: "只读文件检索",
      permissions: ["搜索文件", "读取 Google 文档正文"],
    });
  });

  it("未知 id 返回 null，mergeCatalog 忽略且不崩", () => {
    expect(connectorMeta("slack")).toBeNull();
    const merged = mergeCatalog([
      remote({ id: "slack" as Connector["id"], status: "connected" }),
    ]);
    expect(merged).toHaveLength(7);
    expect(merged.every((connector) => connector.status === "disconnected")).toBe(true);
  });
});

describe("mergeCatalog", () => {
  it("始终展示七个 provider，并补齐服务端缺失项", () => {
    const merged = mergeCatalog([]);
    expect(merged.map((connector) => connector.id)).toEqual([
      "github",
      "gmail",
      "outlook",
      "linear",
      "notion",
      "google_calendar",
      "google_drive",
    ]);
    expect(merged.every((connector) => connector.status === "disconnected")).toBe(true);
    expect(merged.filter((connector) => connector.readOnly)).toHaveLength(6);
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
