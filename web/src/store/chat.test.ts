import { beforeEach, describe, expect, it } from "vitest";
import type { QueuedRequest } from "@/api/types";
import { useChatStore } from "./chat";

function item(overrides: Partial<QueuedRequest> = {}): QueuedRequest {
  return {
    requestId: "req1",
    clientMessageId: "cmid1",
    text: "排队消息",
    createdAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  useChatStore.getState().reset();
});

describe("setQueueFromServer 服务端队列对账", () => {
  it("被退回队列的插话 outgoing 恢复为 queued，并清掉 promoting", () => {
    const state = useChatStore.getState();
    const clientMessageId = state.addOutgoing("排队消息");
    state.updateOutgoing(clientMessageId, {
      requestId: `steer:${clientMessageId}`,
      steer: true,
      status: "done",
    });
    state.markPromoting("req1");

    useChatStore.getState().setQueueFromServer([
      item({ requestId: "req1", clientMessageId }),
    ]);

    const next = useChatStore.getState();
    expect(next.queue).toEqual([
      item({ requestId: "req1", clientMessageId }),
    ]);
    expect(next.promoting).toEqual([]);
    expect(next.outgoing[0]).toMatchObject({
      requestId: "req1",
      steer: false,
      status: "queued",
      errorCode: null,
      errorMessage: null,
    });
  });

  it("普通 queued outgoing 不受影响", () => {
    const state = useChatStore.getState();
    const clientMessageId = state.addOutgoing("排队消息");
    state.updateOutgoing(clientMessageId, {
      requestId: "req1",
      status: "queued",
    });

    useChatStore.getState().setQueueFromServer([
      item({ requestId: "req1", clientMessageId }),
    ]);

    expect(useChatStore.getState().outgoing[0]).toMatchObject({
      requestId: "req1",
      status: "queued",
    });
    expect(useChatStore.getState().outgoing[0]!.steer).toBeUndefined();
  });

  it("本端乐观 setQueue 不触发回退对账", () => {
    const state = useChatStore.getState();
    const clientMessageId = state.addOutgoing("排队消息");
    state.updateOutgoing(clientMessageId, {
      requestId: `steer:${clientMessageId}`,
      steer: true,
      status: "done",
    });

    useChatStore.getState().setQueue([
      item({ requestId: "req1", clientMessageId }),
    ]);

    expect(useChatStore.getState().outgoing[0]!.steer).toBe(true);
    expect(useChatStore.getState().outgoing[0]!.status).toBe("done");
  });
});
