import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/errors";
import { sendMessage, steerRequest } from "@/api/client";
import { useChatStore } from "@/store/chat";
import { useSendMessage } from "./use-chat-actions";

vi.mock("@/api/client", () => ({
  abortRequest: vi.fn(),
  sendMessage: vi.fn(),
  steerRequest: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const mockedSend = vi.mocked(sendMessage);
const mockedSteer = vi.mocked(steerRequest);

/** 在服务端渲染里取出 hook 返回的回调，避免引入 jsdom/testing-library。 */
function captureSend(): (text: string) => Promise<boolean> {
  let captured: ReturnType<typeof useSendMessage> | undefined;
  function Harness() {
    captured = useSendMessage();
    return null;
  }
  renderToStaticMarkup(<Harness />);
  if (!captured) throw new Error("useSendMessage not captured");
  return captured;
}

beforeEach(() => {
  useChatStore.getState().reset();
  mockedSend.mockReset();
  mockedSteer.mockReset();
});

describe("useSendMessage 运行中插话", () => {
  it("running 时走 steer，成功后使用 steerId 且不改变 activeRequestId", async () => {
    useChatStore.getState().setActive("req1", "running", "orig");
    mockedSteer.mockImplementation(async (_requestId, input) => ({
      steerId: `steer:${input.clientMessageId}`,
      requestId: "req1",
      status: "accepted",
    }));

    await expect(captureSend()("插话内容")).resolves.toBe(true);

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

    await expect(captureSend()("插话内容")).resolves.toBe(true);

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

    await expect(captureSend()("插话内容")).resolves.toBe(true);

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().outgoing[0]!.requestId).toBe("req2");
    expect(useChatStore.getState().outgoing[0]!.steer).toBe(false);
  });

  it("其他错误不回退，标记失败", async () => {
    useChatStore.getState().setActive("req1", "running", "orig");
    mockedSteer.mockRejectedValue(new ApiError("INTERNAL_ERROR", "服务端出错了", 500));

    await expect(captureSend()("插话内容")).resolves.toBe(false);

    expect(mockedSend).not.toHaveBeenCalled();
    const state = useChatStore.getState();
    expect(state.outgoing[0]!.status).toBe("failed");
    expect(state.outgoing[0]!.errorCode).toBe("INTERNAL_ERROR");
    expect(state.outgoing[0]!.steer).toBe(true);
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
    expect(useChatStore.getState().outgoing[0]!.requestId).toBe("req2");
    expect(useChatStore.getState().outgoing[0]!.steer).toBeFalsy();
  });

  it("空闲时走普通发送并设置 active", async () => {
    mockedSend.mockResolvedValue({ requestId: "req1", status: "queued" });

    await expect(captureSend()("新消息")).resolves.toBe(true);

    expect(mockedSteer).not.toHaveBeenCalled();
    const state = useChatStore.getState();
    expect(state.activeRequestId).toBe("req1");
    expect(state.activeStatus).toBe("queued");
  });
});
