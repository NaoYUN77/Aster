import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer, ComposerActions } from "./Composer";

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

describe("Composer 插话按钮", () => {
  it("运行中且有输入时同时显示停止与「插话」", () => {
    const html = actions({ activeStatus: "running", hasText: true });

    expect(html).toContain('aria-label="停止回复"');
    expect(html).toContain('aria-label="插话"');
    expect(html).toContain('title="插话"');
  });

  it("运行中没有输入时只显示停止", () => {
    const html = actions({ activeStatus: "running", hasText: false });

    expect(html).toContain('aria-label="停止回复"');
    expect(html).not.toContain('aria-label="插话"');
    expect(html).not.toContain('aria-label="发送"');
  });

  it("排队中不显示插话，只保留停止", () => {
    const html = actions({ activeStatus: "queued", hasText: true });

    expect(html).toContain('aria-label="停止回复"');
    expect(html).not.toContain('aria-label="插话"');
    expect(html).not.toContain('aria-label="发送"');
  });

  it("空闲时只显示发送", () => {
    const html = actions({ activeStatus: null, hasText: true });

    expect(html).toContain('aria-label="发送"');
    expect(html).not.toContain('aria-label="停止回复"');
  });

  it("运行中提示文案说明 Enter 插话", () => {
    const html = renderToStaticMarkup(
      <Composer onSend={async () => true} onStop={noop} activeStatus="running" />,
    );

    expect(html).toContain("正在回复，Enter 插话，Shift+Enter 换行");
    expect(html).not.toContain("正在回复，可随时停止");
  });
});
