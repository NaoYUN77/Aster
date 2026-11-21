import { describe, expect, it } from "vitest";
import { parseServerEvent } from "./events";

const base = {
  requestId: "cred_1",
  connectionId: "conn_1",
  provider: "github",
  slug: "github",
  tool: "github.create_issue_comment",
};

describe("parseServerEvent: credential.request", () => {
  it("按真实契约解析 provider/slug，并给出 120 秒 mock 倒计时", () => {
    const before = Date.now();
    const parsed = parseServerEvent("credential.request", base);
    expect(parsed.type).toBe("credential.request");
    if (parsed.type !== "credential.request") return;
    expect(parsed.request.requestId).toBe("cred_1");
    expect(parsed.request.connector).toEqual({ id: "github", name: "GitHub" });
    expect(parsed.request.tool).toBe("github.create_issue_comment");
    expect(parsed.request.scopes).toEqual([]);
    expect(parsed.request.reason).toBeNull();
    expect(parsed.request.accountHint).toBeNull();
    expect(parsed.request.expiresAt).toBeGreaterThanOrEqual(before + 119_000);
  });

  it("gmail/pending provider 使用可读名称", () => {
    const parsed = parseServerEvent("credential.request", {
      ...base,
      provider: "gmail",
      slug: "gmail",
      tool: "gmail.search",
    });
    expect(parsed.type).toBe("credential.request");
    if (parsed.type === "credential.request") {
      expect(parsed.request.connector).toEqual({ id: "gmail", name: "Gmail" });
    }
  });

  it("畸形事件被忽略", () => {
    expect(parseServerEvent("credential.request", { requestId: "x" }).type).toBe("ignored");
    expect(
      parseServerEvent("credential.request", {
        requestId: "x",
        provider: "github",
        slug: "github",
      }).type,
    ).toBe("ignored");
    expect(parseServerEvent("credential.request", null).type).toBe("ignored");
  });

  it("connector.changed 不需要 payload", () => {
    expect(parseServerEvent("connector.changed", {}).type).toBe("connector.changed");
    expect(parseServerEvent("connector.changed", undefined).type).toBe("ignored");
  });
});

const steerMessage = {
  id: "m2",
  role: "assistant",
  text: "补充后的回答",
  createdAt: 1_760_000_001_000,
  status: "complete",
  requestId: "steer:c1",
  clientMessageId: "c1",
  model: { id: "mock/primary", label: "Mock Primary" },
  errorCode: null,
  tool: null,
};

describe("parseServerEvent: queue", () => {
  const queue = [
    {
      requestId: "req1",
      clientMessageId: "c1",
      text: "排队消息",
      createdAt: 1_760_000_000_000,
    },
  ];

  it("snapshot 解析 queue，缺省时不带该字段", () => {
    const withQueue = parseServerEvent("snapshot", {
      activeRequest: null,
      queue,
      modelVersion: 2,
    });
    expect(withQueue.type).toBe("snapshot");
    if (withQueue.type !== "snapshot") return;
    expect(withQueue.queue).toEqual(queue);

    const withoutQueue = parseServerEvent("snapshot", { activeRequest: null });
    expect(withoutQueue.type).toBe("snapshot");
    if (withoutQueue.type !== "snapshot") return;
    expect(withoutQueue.queue).toBeUndefined();
  });

  it("queue.changed 解析完整 items", () => {
    const parsed = parseServerEvent("queue.changed", { items: queue });
    expect(parsed).toEqual({ type: "queue.changed", items: queue });
  });

  it("畸形 queue 事件被忽略", () => {
    expect(parseServerEvent("queue.changed", { items: [{ requestId: "x" }] }).type).toBe(
      "ignored",
    );
    expect(parseServerEvent("queue.changed", null).type).toBe("ignored");
  });
});

describe("parseServerEvent: steer", () => {
  it("解析 request.steered", () => {
    const parsed = parseServerEvent("request.steered", {
      requestId: "req1",
      steerId: "steer:c1",
      clientMessageId: "c1",
      text: "补充一下",
      createdAt: 1_760_000_000_000,
    });

    expect(parsed).toEqual({
      type: "request.steered",
      requestId: "req1",
      steerId: "steer:c1",
      clientMessageId: "c1",
      text: "补充一下",
      createdAt: 1_760_000_000_000,
    });
  });

  it("解析 steer.done", () => {
    const parsed = parseServerEvent("steer.done", {
      requestId: "req1",
      steerId: "steer:c1",
      message: steerMessage,
    });

    expect(parsed.type).toBe("steer.done");
    if (parsed.type !== "steer.done") return;
    expect(parsed.steerId).toBe("steer:c1");
    expect(parsed.message.id).toBe("m2");
    expect(parsed.message.requestId).toBe("steer:c1");
  });

  it("畸形 steer 事件被忽略", () => {
    expect(parseServerEvent("request.steered", { requestId: "req1" }).type).toBe(
      "ignored",
    );
    expect(parseServerEvent("steer.done", { requestId: "req1" }).type).toBe("ignored");
    expect(parseServerEvent("steer.done", null).type).toBe("ignored");
  });
});
