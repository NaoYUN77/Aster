import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Composer,
  ComposerActions,
  sendModeForKey,
} from "./Composer";

const noop = () => {};

function actions(overrides: {
  activeStatus: "queued" | "running" | null;
  hasText: boolean;
  disabled?: boolean;
}) {
  return renderToStaticMarkup(
    <ComposerActions
      activeStatus={overrides.activeStatus}
      hasText={overrides.hasText}
      disabled={overrides.disabled ?? false}
      onStop={noop}
      onSend={noop}
    />,
  );
}

describe("Composer 运行中显式选择", () => {
  it("运行中且有输入时同时显示停止、排队与立即插入", () => {
    const html = actions({ activeStatus: "running", hasText: true });

    expect(html).toContain('aria-label="停止回复"');
    expect(html).toContain('aria-label="排队"');
    expect(html).toContain('aria-label="立即插入"');
    expect(html).not.toContain('aria-label="发送"');
    expect(html).not.toContain("插话");
  });

  it("运行中没有输入时只显示停止", () => {
    const html = actions({ activeStatus: "running", hasText: false });

    expect(html).toContain('aria-label="停止回复"');
    expect(html).not.toContain('aria-label="排队"');
    expect(html).not.toContain('aria-label="立即插入"');
    expect(html).not.toContain('aria-label="发送"');
  });

  it("排队中保留停止与单个发送，不显示立即插入", () => {
    const html = actions({ activeStatus: "queued", hasText: true });

    expect(html).toContain('aria-label="停止回复"');
    expect(html).toContain('aria-label="发送"');
    expect(html).not.toContain('aria-label="排队"');
    expect(html).not.toContain('aria-label="立即插入"');
  });

  it("空闲时只显示发送", () => {
    const html = actions({ activeStatus: null, hasText: true });

    expect(html).toContain('aria-label="发送"');
    expect(html).not.toContain('aria-label="停止回复"');
  });

  it("运行中提示文案说明 Enter 与 Ctrl/⌘+Enter", () => {
    const html = renderToStaticMarkup(
      <Composer onSend={async () => true} onStop={noop} activeStatus="running" />,
    );

    expect(html).toContain("正在回复，Enter 排队，Ctrl/⌘+Enter 立即插入");
    expect(html).not.toContain("正在回复，可随时停止");
  });
});

describe("Composer 键盘映射", () => {
  const base = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false };

  it("Enter 排队，Ctrl/⌘+Enter 立即插入，Shift+Enter 换行", () => {
    expect(sendModeForKey(base)).toBe("queue");
    expect(sendModeForKey({ ...base, ctrlKey: true })).toBe("steer");
    expect(sendModeForKey({ ...base, metaKey: true })).toBe("steer");
    expect(sendModeForKey({ ...base, shiftKey: true })).toBeNull();
  });

  it("其他按键不触发发送", () => {
    expect(sendModeForKey({ ...base, key: "a" })).toBeNull();
  });
});
