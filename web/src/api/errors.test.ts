import { describe, expect, it } from "vitest";
import { ApiError, requestStatusOf, toApiError } from "./errors";

describe("requestStatusOf", () => {
  it("读取契约错误对象里的 requestStatus", () => {
    expect(
      requestStatusOf({
        error: {
          code: "QUEUE_ITEM_NOT_QUEUED",
          message: "消息已不在队列",
          requestStatus: "running",
        },
      }),
    ).toBe("running");
  });

  it("兼容扁平错误体与顶层 requestStatus", () => {
    expect(
      requestStatusOf({
        code: "QUEUE_ITEM_NOT_QUEUED",
        message: "消息已不在队列",
        requestStatus: "aborted",
      }),
    ).toBe("aborted");
    expect(
      requestStatusOf({
        error: { code: "QUEUE_ITEM_NOT_QUEUED", message: "消息已不在队列" },
        requestStatus: "done",
      }),
    ).toBe("done");
  });

  it("缺失或非字符串时返回 null", () => {
    expect(requestStatusOf(null)).toBeNull();
    expect(
      requestStatusOf({
        error: { code: "QUEUE_ITEM_NOT_QUEUED", message: "消息已不在队列" },
      }),
    ).toBeNull();
    expect(requestStatusOf({ error: { requestStatus: 1 } })).toBeNull();
  });
});

describe("toApiError", () => {
  it("保留 QUEUE_ITEM_NOT_QUEUED 的 requestStatus", () => {
    const error = toApiError(
      {
        error: {
          code: "QUEUE_ITEM_NOT_QUEUED",
          message: "消息已不在队列",
          requestStatus: "failed",
        },
      },
      409,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("QUEUE_ITEM_NOT_QUEUED");
    expect(error.status).toBe(409);
    expect(error.requestStatus).toBe("failed");
  });
});
