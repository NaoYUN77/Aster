import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ApiError } from "@/api/errors";
import {
  abortRequest,
  getQueue,
  promoteRequest,
  sendMessage,
  steerRequest,
} from "@/api/client";
import type { QueuedRequest } from "@/api/types";
import { useChatStore } from "@/store/chat";
import {
  useQueueActions,
  useSendMessage,
  type SendMode,
} from "./use-chat-actions";

vi.mock("@/api/client", () => ({
  abortRequest: vi.fn(),
  getQueue: vi.fn(),
  promoteRequest: vi.fn(),
  sendMessage: vi.fn(),
  steerRequest: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const mockedSend = vi.mocked(sendMessage);
const mockedSteer = vi.mocked(steerRequest);
const mockedPromote = vi.mocked(promoteRequest);
const mockedGetQueue = vi.mocked(getQueue);
const mockedAbort = vi.mocked(abortRequest);

/** 在服务端渲染里取出 hook 返回的回调，避免引入 jsdom/testing-library。 */
function captureSend(): (text: string, mode?: SendMode) => Promise<boolean> {
  let captured: ReturnType<typeof useSendMessage> | undefined;
  function Harness() {
    captured = useSendMessage();
    return null;
  }
  renderToStaticMarkup(<Harness />);
  if (!captured) throw new Error("useSendMessage not captured");
  return captured;
}

function captureQueueActions(): ReturnType<typeof useQueueActions> {
  let captured: ReturnType<typeof useQueueActions> | undefined;
  function Harness() {
    captured = useQueueActions();
    return null;
  }
  renderToStaticMarkup(<Harness />);
  if (!captured) throw new Error("useQueueActions not captured");
  return captured;
}

function seedQueueItem(): QueuedRequest {
  const state = useChatStore.getState();
  const clientMessageId = state.addOutgoing("排队消息");
  state.updateOutgoing(clientMessageId, { requestId: "req1", status: "queued" });
  const item: QueuedRequest = {
    requestId: "req1",
    clientMessageId,
    text: "排队消息",
    createdAt: 1,
  };
  state.setQueue([item]);
  return item;
}

beforeEach(() => {
  useChatStore.getState().reset();
  mockedSend.mockReset();
  mockedSteer.mockReset();
  mockedPromote.mockReset();
  mockedGetQueue.mockReset();
  mockedAbort.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.info).mockReset();
  vi.mocked(toast.success).mockReset();
});

describe("useSendMessage 运行中插话", () => {
  it("显式 steer 时走 steer，成功后使用 steerId 且不改变 activeRequestId", async () => {
    useChatStore.getState().setActive("req1", "running", "orig");
    mockedSteer.mockImplementation(async (_requestId, input) => ({
      steerId: `steer:${input.clientMessageId}`,
      requestId: "req1",
      status: "accepted",
    }));

    await expect(captureSend()("插话内容", "steer")).resolves.toBe(true);

    expect(mockedSteer).toHaveBeenCalledTimes(1);
    expect(mockedSend).not.toHaveBeenCalled();
    const [requestId, input] = mockedSteer.mock.calls[0]!;
    expect(requestId).toBe("req1");
    expect(input.text).toBe("插话内容");

    const state = useChatStore.getState();
    expect(state.outgoing).toHaveLength(1);
    expect(state.outgoing[0]!.clientMessageId).toBe(input.clientMessageId);
    expect(state.outgoing[0]!.requestId).toBe(`steer:${input.clientMessageId}`);
    expect(state.outgoing[0]!.status).toBe("done");
    expect(state.outgoing[0]!.steer).toBe(true);
    expect(state.activeRequestId).toBe("req1");
    expect(state.activeStatus).toBe("running");
  });

  it("409 NO_ACTIVE_REQUEST 用同一个 clientMessageId 回退普通发送", async () => {
    useChatStore.getState().setActive("req1", "running", "orig");
    mockedSteer.mockRejectedValue(
      new ApiError("NO_ACTIVE_REQUEST", "当前没有正在回复的请求", 409),
    );
    mockedSend.mockResolvedValue({ requestId: "req2", status: "queued" });

    await expect(captureSend()("插话内容", "steer")).resolves.toBe(true);

    const steerInput = mockedSteer.mock.calls[0]![1];
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend.mock.calls[0]![0].clientMessageId).toBe(
      steerInput.clientMessageId,
    );

    const state = useChatStore.getState();
    expect(state.outgoing[0]!.requestId).toBe("req2");
    expect(state.outgoing[0]!.status).toBe("queued");
    expect(state.outgoing[0]!.steer).toBe(false);
    expect(state.activeRequestId).toBe("req2");
  });

  it("409 REQUEST_NOT_ACTIVE 也回退普通发送", async () => {
    useChatStore.getState().setActive("req1", "running", "orig");
    mockedSteer.mockRejectedValue(
      new ApiError("REQUEST_NOT_ACTIVE", "请求已结束", 409),
    );
    mockedSend.mockResolvedValue({ requestId: "req2", status: "queued" });

    await expect(captureSend()("插话内容", "steer")).resolves.toBe(true);

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().outgoing[0]!.requestId).toBe("req2");
    expect(useChatStore.getState().outgoing[0]!.steer).toBe(false);
  });

  it("其他错误不回退，标记失败", async () => {
    useChatStore.getState().setActive("req1", "running", "orig");
    mockedSteer.mockRejectedValue(new ApiError("INTERNAL_ERROR", "服务端出错了", 500));

    await expect(captureSend()("插话内容", "steer")).resolves.toBe(false);

    expect(mockedSend).not.toHaveBeenCalled();
    const state = useChatStore.getState();
    expect(state.outgoing[0]!.status).toBe("failed");
    expect(state.outgoing[0]!.errorCode).toBe("INTERNAL_ERROR");
    expect(state.outgoing[0]!.steer).toBe(true);
    expect(state.activeRequestId).toBe("req1");
    expect(state.activeStatus).toBe("running");
  });
});

describe("useSendMessage 运行中默认排队", () => {
  it("running 下不传 mode 时走普通发送，并把消息加入本地队列", async () => {
    useChatStore.getState().setActive("req1", "running", "orig");
    mockedSend.mockResolvedValue({ requestId: "req2", status: "queued" });

    await expect(captureSend()("排队内容")).resolves.toBe(true);

    expect(mockedSteer).not.toHaveBeenCalled();
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const state = useChatStore.getState();
    expect(state.outgoing[0]!.status).toBe("queued");
    expect(state.outgoing[0]!.steer).toBeFalsy();
    expect(state.queue).toEqual([
      {
        requestId: "req2",
        clientMessageId: state.outgoing[0]!.clientMessageId,
        text: "排队内容",
        createdAt: state.outgoing[0]!.createdAt,
      },
    ]);
    // 原运行中的请求仍然是 active，排队消息不抢占。
    expect(state.activeRequestId).toBe("req1");
    expect(state.activeStatus).toBe("running");
  });
});

describe("useSendMessage 非运行状态保持原语义", () => {
  it("queued 时走普通发送", async () => {
    useChatStore.getState().setActive("req1", "queued", "orig");
    mockedSend.mockResolvedValue({ requestId: "req2", status: "queued" });

    await expect(captureSend()("排队消息")).resolves.toBe(true);

    expect(mockedSteer).not.toHaveBeenCalled();
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const state = useChatStore.getState();
    expect(state.outgoing[0]!.requestId).toBe("req2");
    expect(state.outgoing[0]!.steer).toBeFalsy();
    expect(state.queue.map((item) => item.requestId)).toEqual(["req2"]);
  });

  it("空闲时走普通发送并设置 active", async () => {
    mockedSend.mockResolvedValue({ requestId: "req1", status: "queued" });

    await expect(captureSend()("新消息")).resolves.toBe(true);

    expect(mockedSteer).not.toHaveBeenCalled();
    const state = useChatStore.getState();
    expect(state.activeRequestId).toBe("req1");
    expect(state.activeStatus).toBe("queued");
    expect(state.queue.map((item) => item.requestId)).toEqual(["req1"]);
  });

  it("POST 响应晚于 running 事件时不把状态覆盖回排队中", async () => {
    let resolveSend!: (value: { requestId: string; status: "queued" }) => void;
    mockedSend.mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );

    const pending = captureSend()("新消息");
    const clientMessageId = useChatStore.getState().outgoing[0]!.clientMessageId;

    // 模拟 SSE request.queued + request.running 先于 POST 响应到达。
    const state = useChatStore.getState();
    state.updateOutgoing(clientMessageId, {
      requestId: "req1",
      status: "running",
    });
    state.setActive("req1", "running", clientMessageId);

    resolveSend({ requestId: "req1", status: "queued" });
    await expect(pending).resolves.toBe(true);

    expect(useChatStore.getState().outgoing[0]!.status).toBe("running");
    expect(useChatStore.getState().activeStatus).toBe("running");
    expect(useChatStore.getState().queue).toHaveLength(0);
  });

  it("POST 响应晚于 done 事件时保留最终状态", async () => {
    let resolveSend!: (value: { requestId: string; status: "queued" }) => void;
    mockedSend.mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );

    const pending = captureSend()("新消息");
    const clientMessageId = useChatStore.getState().outgoing[0]!.clientMessageId;
    useChatStore.getState().updateOutgoing(clientMessageId, {
      requestId: "req1",
      status: "done",
    });

    resolveSend({ requestId: "req1", status: "queued" });
    await expect(pending).resolves.toBe(true);

    expect(useChatStore.getState().outgoing[0]!.status).toBe("done");
    // 晚到的 POST 响应不能把已完成请求重新设为 active。
    expect(useChatStore.getState().activeRequestId).toBeNull();
  });
});

describe("useQueueActions", () => {
  it("promote 成功移除队列行，并把本端 outgoing 标记为插话", async () => {
    const item = seedQueueItem();
    mockedPromote.mockResolvedValue({
      requestId: "req1",
      mode: "steered",
      steerId: `steer:${item.clientMessageId}`,
    });

    await captureQueueActions().promote(item);

    const state = useChatStore.getState();
    expect(state.queue).toHaveLength(0);
    expect(state.outgoing).toHaveLength(1);
    expect(state.outgoing[0]!.requestId).toBe(`steer:${item.clientMessageId}`);
    expect(state.outgoing[0]!.steer).toBe(true);
    expect(state.outgoing[0]!.status).toBe("done");
    expect(Object.keys(state.live)).toHaveLength(0);
    expect(toast.success).toHaveBeenCalledWith("已插入本轮");
  });

  it("promote 返回 started 时移除队列行，不伪造插话标记", async () => {
    const item = seedQueueItem();
    mockedPromote.mockResolvedValue({ requestId: "req1", mode: "started" });

    await captureQueueActions().promote(item);

    expect(useChatStore.getState().queue).toHaveLength(0);
    expect(useChatStore.getState().outgoing[0]!.steer).toBeFalsy();
    expect(toast.success).toHaveBeenCalledWith("已开始执行");
  });

  it("409 QUEUE_ITEM_NOT_QUEUED 刷新队列并提示", async () => {
    const item = seedQueueItem();
    mockedPromote.mockRejectedValue(
      new ApiError("QUEUE_ITEM_NOT_QUEUED", "消息已不在队列", 409),
    );
    mockedGetQueue.mockResolvedValue({ items: [] });

    await captureQueueActions().promote(item);

    expect(mockedGetQueue).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().queue).toHaveLength(0);
    expect(toast.info).toHaveBeenCalledWith("该消息已开始或已结束");
  });

  it("其他 promote 错误保留队列行并 toast", async () => {
    const item = seedQueueItem();
    mockedPromote.mockRejectedValue(
      new ApiError("INTERNAL_ERROR", "服务端出错了", 500),
    );

    await captureQueueActions().promote(item);

    expect(mockedGetQueue).not.toHaveBeenCalled();
    expect(useChatStore.getState().queue).toHaveLength(1);
    expect(toast.error).toHaveBeenCalled();
  });

  it("取消成功移除队列行和本地气泡", async () => {
    const item = seedQueueItem();
    mockedAbort.mockResolvedValue(undefined);

    await captureQueueActions().cancel(item);

    expect(mockedAbort).toHaveBeenCalledWith("req1");
    expect(useChatStore.getState().queue).toHaveLength(0);
    expect(useChatStore.getState().outgoing).toHaveLength(0);
    expect(toast.success).toHaveBeenCalledWith("已取消排队");
  });
});
