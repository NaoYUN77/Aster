import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type MockStore = typeof import("./store");

let store: MockStore;
let events: Array<{ event: string; data: unknown }> = [];

beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  store = await import("./store");
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllTimers();
  events = [];
  store.mockReset();
});

describe("mock connectors 真实契约", () => {
  it("初始返回 providers，connections 为空", () => {
    const response = store.mockConnectors();
    expect(response.providers.map((item) => item.provider)).toEqual([
      "github",
      "gmail",
    ]);
    expect(response.connections).toEqual([]);
    expect(response.mock).toBe(true);
  });

  it("create 幂等：第一次 pending，第二次 created=false", () => {
    const first = store.mockCreateConnector("github", "github");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.connection).toMatchObject({
      provider: "github",
      slug: "github",
      status: "pending",
    });

    const second = store.mockCreateConnector("github", "github");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.connection.id).toBe(first.connection.id);
  });

  it("oauth/start 返回 url，并推送 connected 的 connector.changed", () => {
    store.mockCreateConnector("gmail", "gmail");
    const unsubscribe = store.subscribeMockEvents((event) => events.push(event));

    const started = store.mockStartConnectorOAuth("gmail");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.url).toContain("provider=gmail");
    expect(started.url).toContain("slug=gmail");

    vi.advanceTimersByTime(1_200);
    const changed = events.filter((event) => event.event === "connector.changed");
    expect(changed.length).toBeGreaterThanOrEqual(2);
    const last = changed.at(-1)!.data as {
      connection: { status: string; accountLabel: string | null };
    };
    expect(last.connection.status).toBe("connected");
    expect(last.connection.accountLabel).toBe("aster.demo@gmail.com");
    unsubscribe();
  });

  it("delete 把连接保留为 revoked，供同一 slug 重新授权", () => {
    store.mockCreateConnector("github", "github");
    const unsubscribe = store.subscribeMockEvents((event) => events.push(event));

    store.mockDeleteConnector("github");

    const connections = store.mockConnectors().connections;
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      slug: "github",
      status: "revoked",
      accountLabel: null,
      scopes: [],
    });
    const last = events.at(-1)?.data as { connection: { status: string } };
    expect(last.connection.status).toBe("revoked");
    unsubscribe();
  });

  it("mock credential.request 使用 connectionId/provider/slug/tool", () => {
    const created = store.mockCreateConnector("github", "github");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const unsubscribe = store.subscribeMockEvents((event) => events.push(event));

    store.mockRequestCredential("github");

    const event = events.find((item) => item.event === "credential.request");
    expect(event?.data).toMatchObject({
      connectionId: created.connection.id,
      provider: "github",
      slug: "github",
      tool: "github.create_issue_comment",
    });
    unsubscribe();
  });
});
