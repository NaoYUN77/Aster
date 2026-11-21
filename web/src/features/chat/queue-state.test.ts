import { describe, expect, it } from "vitest";
import type { ParsedServerEvent } from "@/api/events";
import type { QueuedRequest } from "@/api/types";
import { reduceQueue } from "./queue-state";

function item(requestId: string): QueuedRequest {
  return {
    requestId,
    clientMessageId: `c-${requestId}`,
    text: `消息 ${requestId}`,
    createdAt: 1,
  };
}

describe("reduceQueue", () => {
  it("queue.changed 整体替换本地队列", () => {
    const next = [item("req2"), item("req3")];
    const event: ParsedServerEvent = { type: "queue.changed", items: next };

    expect(reduceQueue([item("req1")], event)).toEqual(next);
  });

  it("request.running 移除被领取的行", () => {
    const event: ParsedServerEvent = {
      type: "request.running",
      requestId: "req1",
    };

    expect(reduceQueue([item("req1"), item("req2")], event)).toEqual([
      item("req2"),
    ]);
  });

  it("request.aborted 移除被取消的行", () => {
    const event: ParsedServerEvent = {
      type: "request.aborted",
      requestId: "req2",
    };

    expect(reduceQueue([item("req1"), item("req2")], event)).toEqual([
      item("req1"),
    ]);
  });

  it("其他事件不改变队列", () => {
    const event: ParsedServerEvent = {
      type: "request.done",
      requestId: "req1",
      message: {
        id: "m1",
        role: "assistant",
        text: "ok",
        createdAt: 1,
        status: "complete",
        requestId: "req1",
        clientMessageId: "c1",
        model: null,
        errorCode: null,
        tool: null,
      },
      usage: {
        requested: { id: "m", label: "M", kind: "primary" },
        actual: { id: "m", label: "M" },
        kind: "primary",
        degraded: false,
      },
    };

    expect(reduceQueue([item("req1")], event)).toEqual([item("req1")]);
  });
});
