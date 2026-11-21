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
    connectedAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("catalog", () => {
  it("七个 provider 都有 meta，且不再出现只读文案", () => {
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
      expect(meta.tagline).not.toContain("只读");
      expect(`${meta.description}${meta.permissions.join("")}`).not.toContain(
        "只读",
      );
    }
  });

  it("Notion / Calendar / Drive 使用读写口径的文案与权限", () => {
    expect(connectorMeta("notion")).toMatchObject({
      name: "Notion",
      tagline: "页面与数据库读写",
      permissions: ["搜索页面/数据库", "读取与写入页面内容"],
    });
    expect(connectorMeta("google_calendar")).toMatchObject({
      name: "Google Calendar",
      tagline: "日程读取与创建",
      permissions: ["读取日历与事件", "创建日程"],
    });
    expect(connectorMeta("google_drive")).toMatchObject({
      name: "Google Drive",
      tagline: "文件检索与读写",
      permissions: ["搜索文件", "读取与写入 Google 文档"],
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
    expect(merged.every((connector) => !connector.description.includes("只读"))).toBe(
      true,
    );
  });

  it("以服务端状态为准，未知 id 被忽略", () => {
    const merged = mergeCatalog([
      remote({
        id: "gmail",
        name: "Gmail",
        status: "connected",
        account: { id: "a@b.c", label: "a@b.c" },
        scopes: ["gmail.modify"],
        connectedAt: "2026-01-01T00:00:00.000Z",
      }),
      remote({ id: "slack" as Connector["id"], status: "connected" }),
    ]);

    const gmail = merged.find((connector) => connector.id === "gmail");
    expect(gmail?.status).toBe("connected");
    expect(gmail?.account?.label).toBe("a@b.c");
    expect(merged.some((connector) => (connector.id as string) === "slack")).toBe(false);
  });
});
