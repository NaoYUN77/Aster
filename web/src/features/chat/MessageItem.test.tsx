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
