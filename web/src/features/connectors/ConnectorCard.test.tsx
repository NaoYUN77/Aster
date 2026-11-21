import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Connector } from "@/api/connectors";
import { ConnectorCard } from "./ConnectorCard";

function connector(overrides: Partial<Connector>): Connector {
  return {
    id: "github",
    name: "GitHub",
    description: "",
    status: "disconnected",
    account: null,
    scopes: [],
    connectedAt: null,
    lastError: null,
    ...overrides,
  };
}

function render(item: Connector): string {
  return renderToStaticMarkup(
    <ConnectorCard
      connector={item}
      onConnect={() => {}}
      onDisconnect={() => {}}
      onCancel={() => {}}
      onOpen={() => {}}
    />,
  );
}

describe("ConnectorCard 四态", () => {
  it("disconnected：灰色卡片，显示「连接」按钮", () => {
    const html = render(connector({ status: "disconnected" }));
    expect(html).toContain('data-status="disconnected"');
    expect(html).toContain("未连接");
    expect(html).toContain("连接");
    expect(html).not.toContain("断开");
  });

  it("pending：黄色卡片，显示「等待授权…」与「取消」", () => {
    const html = render(connector({ status: "pending" }));
    expect(html).toContain('data-status="pending"');
    expect(html).toContain("等待授权…");
    expect(html).toContain("取消");
    expect(html).not.toContain("断开");
  });

  it("pending 且需要手动打开：渲染「打开授权页」链接", () => {
    const html = renderToStaticMarkup(
      <ConnectorCard
        connector={connector({ status: "pending" })}
        manualAuthUrl="https://github.com/login/oauth/authorize?state=x"
        onConnect={() => {}}
        onDisconnect={() => {}}
        onCancel={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("打开授权页");
    expect(html).toContain(
      'href="https://github.com/login/oauth/authorize?state=x"',
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("connected：绿色卡片，显示 accountLabel 与「断开」", () => {
    const html = render(
      connector({
        status: "connected",
        account: { id: "octocat", label: "octocat" },
      }),
    );
    expect(html).toContain('data-status="connected"');
    expect(html).toContain("已连接");
    expect(html).toContain("octocat");
    expect(html).toContain("断开");
    expect(html).not.toContain("取消");
  });

  it("error：红色卡片，显示错误文案与「重试」", () => {
    const html = render(
      connector({
        id: "gmail",
        name: "Gmail",
        status: "error",
        lastError: "服务器未配置 OAuth 凭据",
      }),
    );
    expect(html).toContain('data-status="error"');
    expect(html).toContain("连接异常");
    expect(html).toContain("服务器未配置 OAuth 凭据");
    expect(html).toContain("重试");
    expect(html).not.toContain("只读");
  });
});
