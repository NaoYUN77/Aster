import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DisplayMessage } from "./display-messages";
import { MessageItem } from "./MessageItem";

function displayMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: "tool-1",
    role: "assistant",
    text: "",
    createdAt: 0,
    status: "complete",
    requestId: null,
    clientMessageId: null,
    model: null,
    errorCode: null,
    errorMessage: null,
    tool: null,
    local: false,
    steer: false,
    ...overrides,
  };
}

describe("MessageItem 工具行", () => {
  it("assistant 工具消息渲染 ToolRow", () => {
    const html = renderToStaticMarkup(
      <MessageItem
        message={displayMessage({
          tool: { name: "current_time", status: "done" },
        })}
        onRetry={() => {}}
      />,
    );

    expect(html).toContain("工具：current_time");
    expect(html).toContain("完成");
    expect(html).not.toContain("无文本内容");
  });

  it("assistant 工具失败时展示失败状态", () => {
    const html = renderToStaticMarkup(
      <MessageItem
        message={displayMessage({
          tool: { name: "current_time", status: "failed" },
        })}
        onRetry={() => {}}
      />,
    );

    expect(html).toContain("工具：current_time");
    expect(html).toContain("失败");
  });
});

describe("MessageItem 插话标记", () => {
  it("用户插话气泡显示「插话 · 本轮」", () => {
    const html = renderToStaticMarkup(
      <MessageItem
        message={displayMessage({
          id: "u1",
          role: "user",
          text: "补充一下",
          requestId: "steer:c1",
          steer: true,
        })}
        onRetry={() => {}}
      />,
    );

    expect(html).toContain("补充一下");
    expect(html).toContain("插话 · 本轮");
  });

  it("普通用户消息不显示插话标记", () => {
    const html = renderToStaticMarkup(
      <MessageItem
        message={displayMessage({
          id: "u1",
          role: "user",
          text: "普通消息",
          requestId: "req1",
          steer: false,
        })}
        onRetry={() => {}}
      />,
    );

    expect(html).not.toContain("插话 · 本轮");
  });
});
