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

describe("MessageItem 后台任务与提醒卡片", () => {
  it("定时任务与监控动态以清晰卡片和来源标签渲染", () => {
    const routineHtml = renderToStaticMarkup(
      <MessageItem
        message={displayMessage({
          id: "sys-1",
          role: "system",
          hostSource: "routine",
          text: "今日 AI 简报：Model X 发布",
          createdAt: 1_760_000_000_000,
        })}
        onRetry={() => {}}
      />,
    );
    expect(routineHtml).toContain("定时任务");
    expect(routineHtml).toContain("今日 AI 简报：Model X 发布");

    const watchHtml = renderToStaticMarkup(
      <MessageItem
        message={displayMessage({
          id: "sys-2",
          role: "system",
          hostSource: "watch",
          text: "GitHub CI 通过",
          createdAt: 1_760_000_000_000,
        })}
        onRetry={() => {}}
      />,
    );
    expect(watchHtml).toContain("监控动态");
    expect(watchHtml).toContain("GitHub CI 通过");
  });
});
