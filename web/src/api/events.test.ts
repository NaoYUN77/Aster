import { describe, expect, it } from "vitest";
import { parseServerEvent } from "./events";

const base = {
  requestId: "cred_1",
  connector: { id: "github", name: "GitHub" },
  tool: "github.create_issue_comment",
  scopes: ["repo"],
};

describe("parseServerEvent: credential.request", () => {
  it("把秒级过期时间换算成毫秒", () => {
    const parsed = parseServerEvent("credential.request", {
      ...base,
      expiresAt: 1_760_000_000,
    });
    expect(parsed.type).toBe("credential.request");
    if (parsed.type !== "credential.request") return;
    expect(parsed.request.expiresAt).toBe(1_760_000_000_000);
    expect(parsed.request.connector).toEqual({ id: "github", name: "GitHub" });
    expect(parsed.request.scopes).toEqual(["repo"]);
    expect(parsed.request.reason).toBeNull();
  });

  it("接受毫秒时间戳与 ISO 字符串", () => {
    const millis = Date.now() + 60_000;
    const fromMillis = parseServerEvent("credential.request", {
      ...base,
      expiresAt: millis,
    });
    expect(fromMillis.type).toBe("credential.request");
    if (fromMillis.type === "credential.request") {
      expect(fromMillis.request.expiresAt).toBe(millis);
    }

    const iso = new Date(millis).toISOString();
    const fromIso = parseServerEvent("credential.request", { ...base, expiresAt: iso });
    expect(fromIso.type).toBe("credential.request");
    if (fromIso.type === "credential.request") {
      expect(fromIso.request.expiresAt).toBe(millis);
    }
  });

  it("缺少过期时间时按 ttlSeconds 计算，默认 120 秒", () => {
    const before = Date.now();
    const parsed = parseServerEvent("credential.request", { ...base, ttlSeconds: 30 });
    expect(parsed.type).toBe("credential.request");
    if (parsed.type !== "credential.request") return;
    expect(parsed.request.expiresAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(parsed.request.expiresAt).toBeLessThanOrEqual(Date.now() + 30_000);

    const fallback = parseServerEvent("credential.request", base);
    expect(fallback.type).toBe("credential.request");
    if (fallback.type !== "credential.request") return;
    expect(fallback.request.expiresAt).toBeGreaterThanOrEqual(before + 119_000);
  });

  it("缺少 connector 字段时给出兜底名称，畸形事件被忽略", () => {
    const parsed = parseServerEvent("credential.request", {
      requestId: "cred_2",
      tool: "gmail.search",
    });
    expect(parsed.type).toBe("credential.request");
    if (parsed.type === "credential.request") {
      expect(parsed.request.connector.id).toBe("unknown");
      expect(parsed.request.scopes).toEqual([]);
    }

    expect(parseServerEvent("credential.request", { requestId: "x" }).type).toBe("ignored");
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
