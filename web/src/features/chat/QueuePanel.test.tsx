import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QueuedRequest } from "@/api/types";
import { QueuePanel } from "./QueuePanel";

const noop = async () => {};

function item(
  overrides: Partial<QueuedRequest> & Pick<QueuedRequest, "requestId">,
): QueuedRequest {
  return {
    clientMessageId: `c-${overrides.requestId}`,
    text: "排队消息",
    createdAt: 1,
    ...overrides,
  };
}

function render(
  items: QueuedRequest[],
  activeStatus: "queued" | "running" | null = "running",
  promoting: string[] = [],
) {
  return renderToStaticMarkup(
    <QueuePanel
      items={items}
      activeStatus={activeStatus}
      promoting={promoting}
      onPromote={noop}
      onCancel={noop}
    />,
  );
}

describe("QueuePanel", () => {
  it("空队列不渲染", () => {
    expect(render([])).toBe("");
  });

  it("按 FIFO 顺序渲染多条，并显示条数与全文 title", () => {
    const html = render([
      item({ requestId: "req1", text: "第一条消息" }),
      item({ requestId: "req2", text: "第二条消息" }),
    ]);

    expect(html).toContain("队列 · 2 条");
    expect(html.indexOf("第一条消息")).toBeLessThan(html.indexOf("第二条消息"));
    expect(html).toContain('title="第一条消息"');
    expect(html).toContain("立即插入");
    expect(html).toContain("取消");
  });

  it("运行中「立即插入」可点", () => {
    const html = render([item({ requestId: "req1" })], "running");

    expect(html).not.toContain('title="当前没有运行中的回复"');
    expect(html).toContain("立即插入");
  });

  it("排队中或空闲时「立即插入」禁用并说明原因", () => {
    for (const status of ["queued", null] as const) {
      const html = render([item({ requestId: "req1" })], status);
      expect(html).toContain('title="当前没有运行中的回复"');
      expect(html).toContain('disabled=""');
      expect(html).toContain("立即插入");
    }
  });

  it("promoting 中的行显示 loading 并禁用两个操作", () => {
    const html = render([item({ requestId: "req1" })], "running", ["req1"]);

    expect(html).toContain("立即插入");
    // 立即插入与取消都带 disabled。
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
