import { describe, expect, it } from "vitest";
import type { ModelUsage, UiMessage } from "@/api/types";
import type { OutgoingMessage } from "@/store/chat";
import {
  buildDisplayMessages,
  type DisplayState,
} from "./display-messages";

function message(
  overrides: Partial<UiMessage> & Pick<UiMessage, "id" | "role">,
): UiMessage {
  return {
    text: "",
    createdAt: 0,
    status: "complete",
    requestId: null,
    clientMessageId: null,
    model: null,
    errorCode: null,
    tool: null,
    ...overrides,
  };
}

function outgoing(
  overrides: Partial<OutgoingMessage> & Pick<OutgoingMessage, "clientMessageId">,
): OutgoingMessage {
  return {
    text: "hi",
    createdAt: 0,
    status: "done",
    ...overrides,
  };
}

function state(overrides: Partial<DisplayState> = {}): DisplayState {
  return {
    live: {},
    outgoing: [],
    usage: {},
    failures: {},
    ...overrides,
  };
}

const usage: ModelUsage = {
  requested: { id: "mock/primary", label: "Mock Primary", kind: "primary" },
  actual: { id: "mock/primary", label: "Mock Primary" },
  kind: "primary",
  degraded: false,
};

describe("buildDisplayMessages 去重", () => {
  it("done 后历史 user 带 requestId/clientMessageId 时只保留一个用户气泡", () => {
    const history = [
      message({
        id: "u1",
        role: "user",
        text: "你好",
        createdAt: 1,
        requestId: "req1",
        clientMessageId: "c1",
      }),
      message({
        id: "a1",
        role: "assistant",
        text: "回复",
        createdAt: 2,
        requestId: "req1",
        clientMessageId: "c1",
      }),
    ];
    const result = buildDisplayMessages(
      history,
      state({ outgoing: [outgoing({ clientMessageId: "c1", requestId: "req1" })] }),
    );

    expect(result.filter((item) => item.role === "user")).toHaveLength(1);
    const user = result.find((item) => item.role === "user")!;
    expect(user.local).toBe(false);
    expect(user.id).toBe("u1");
    expect(user.requestId).toBe("req1");
    expect(user.clientMessageId).toBe("c1");
  });

  it("历史只有 requestId、缺 clientMessageId 时也能按 requestId 去重", () => {
    const history = [
      message({ id: "u1", role: "user", text: "hi", requestId: "req1" }),
    ];
    const result = buildDisplayMessages(
      history,
      state({ outgoing: [outgoing({ clientMessageId: "c1", requestId: "req1" })] }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.local).toBe(false);
  });

  it("连续发送两条相同文本时两条都保留，不按文本去重", () => {
    const outgoingItems = [
      outgoing({ clientMessageId: "c1", requestId: "req1", text: "测试", createdAt: 1 }),
      outgoing({ clientMessageId: "c2", requestId: "req2", text: "测试", createdAt: 2 }),
    ];

    // 历史尚未返回时，两条本地气泡都在。
    const beforeHistory = buildDisplayMessages([], state({ outgoing: outgoingItems }));
    expect(beforeHistory.filter((item) => item.role === "user")).toHaveLength(2);

    // 历史到达后，两条服务器 user 各匹配一条本地消息。
    const history = [
      message({
        id: "u1",
        role: "user",
        text: "测试",
        createdAt: 1,
        requestId: "req1",
        clientMessageId: "c1",
      }),
      message({
        id: "u2",
        role: "user",
        text: "测试",
        createdAt: 2,
        requestId: "req2",
        clientMessageId: "c2",
      }),
    ];
    const afterHistory = buildDisplayMessages(history, state({ outgoing: outgoingItems }));
    expect(afterHistory.filter((item) => item.role === "user")).toHaveLength(2);
    expect(afterHistory.every((item) => item.local === false)).toBe(true);
  });

  it("$model 命令没有服务器 user entry 时保留本地气泡", () => {
    const history = [
      message({
        id: "a1",
        role: "assistant",
        text: "当前模型：Mock Primary",
        requestId: "req1",
        clientMessageId: "c1",
      }),
    ];
    const result = buildDisplayMessages(
      history,
      state({
        outgoing: [
          outgoing({
            clientMessageId: "c1",
            requestId: "req1",
            text: "$model",
            status: "done",
          }),
        ],
      }),
    );

    const users = result.filter((item) => item.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.local).toBe(true);
    expect(users[0]!.text).toBe("$model");
    expect(result.filter((item) => item.role === "assistant")).toHaveLength(1);
  });

  it("历史与 live 同 id 合并时保留 live 的关联字段和最终状态", () => {
    const history = [
      message({
        id: "a1",
        role: "assistant",
        text: "历史文本",
        requestId: null,
        status: "complete",
      }),
    ];
    const result = buildDisplayMessages(
      history,
      state({
        live: {
          a1: message({
            id: "a1",
            role: "assistant",
            text: "实时文本",
            requestId: "req1",
            clientMessageId: "c1",
            status: "complete",
            model: { id: "mock/primary", label: "Mock Primary" },
          }),
        },
        usage: { a1: usage },
      }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("历史文本");
    expect(result[0]!.requestId).toBe("req1");
    expect(result[0]!.clientMessageId).toBe("c1");
    expect(result[0]!.model?.label).toBe("Mock Primary");
  });

  it("旧服务端既无 requestId 也无 clientMessageId 时不做文本匹配", () => {
    const history = [
      message({ id: "u1", role: "user", text: "测试", requestId: null }),
    ];
    const result = buildDisplayMessages(
      history,
      state({
        outgoing: [
          outgoing({ clientMessageId: "c1", requestId: "req1", text: "测试" }),
        ],
      }),
    );

    // 无法可靠关联时宁可保留本地气泡，也不把两条合法消息按文本合并。
    expect(result.filter((item) => item.role === "user")).toHaveLength(2);
  });

  it("失败/停止且没有服务器 user 的本地气泡仍保留", () => {
    const failed = buildDisplayMessages(
      [],
      state({
        outgoing: [
          outgoing({
            clientMessageId: "c1",
            requestId: "req1",
            text: "太长",
            status: "failed",
            errorCode: "TEXT_TOO_LONG",
            errorMessage: "消息过长，最多 32000 个字符",
          }),
        ],
        failures: { req1: { code: "TEXT_TOO_LONG", message: "消息过长，最多 32000 个字符" } },
      }),
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.status).toBe("failed");
    expect(failed[0]!.errorCode).toBe("TEXT_TOO_LONG");

    const aborted = buildDisplayMessages(
      [],
      state({
        outgoing: [
          outgoing({
            clientMessageId: "c2",
            requestId: "req2",
            text: "被停止",
            status: "aborted",
          }),
        ],
      }),
    );
    expect(aborted).toHaveLength(1);
    expect(aborted[0]!.status).toBe("aborted");
  });

  it("断线重连/刷新后历史与 live 重复 assistant 不产生第二条", () => {
    const history = [
      message({ id: "u1", role: "user", text: "hi", requestId: "req1", clientMessageId: "c1" }),
      message({
        id: "a1",
        role: "assistant",
        text: "回复",
        requestId: "req1",
        clientMessageId: "c1",
      }),
    ];
    const result = buildDisplayMessages(
      history,
      state({
        live: {
          a1: message({
            id: "a1",
            role: "assistant",
            text: "回复",
            requestId: "req1",
            clientMessageId: "c1",
          }),
        },
      }),
    );

    expect(result).toHaveLength(2);
    expect(result.filter((item) => item.role === "assistant")).toHaveLength(1);
  });
});
