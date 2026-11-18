import { describe, expect, it } from "vitest";
import { isAwaitingAuthorization } from "./connector-awaiting";

const attempt = { status: "pending" as const, manualAuthUrl: null };

describe("isAwaitingAuthorization", () => {
  it("本轮成功拿到授权 URL 后才是等待授权", () => {
    expect(
      isAwaitingAuthorization({
        connectorStatus: "disconnected",
        attempt,
        attemptFailed: false,
        attemptInFlight: false,
      }),
    ).toBe(true);
  });

  it("列表 pending 且本轮没报错/没请求时是等待授权", () => {
    expect(
      isAwaitingAuthorization({
        connectorStatus: "pending",
        attempt: undefined,
        attemptFailed: false,
        attemptInFlight: false,
      }),
    ).toBe(true);
  });

  it("本轮失败后即使列表仍是 pending 也不再显示等待授权", () => {
    expect(
      isAwaitingAuthorization({
        connectorStatus: "pending",
        attempt: undefined,
        attemptFailed: true,
        attemptInFlight: false,
      }),
    ).toBe(false);
  });

  it("请求进行中不显示等待授权（授权 URL 尚未发出）", () => {
    expect(
      isAwaitingAuthorization({
        connectorStatus: "pending",
        attempt: undefined,
        attemptFailed: false,
        attemptInFlight: true,
      }),
    ).toBe(false);
  });

  it("已连接时永远不显示等待授权", () => {
    expect(
      isAwaitingAuthorization({
        connectorStatus: "connected",
        attempt,
        attemptFailed: false,
        attemptInFlight: false,
      }),
    ).toBe(false);
  });

  it("未连接且没有本轮结果时不显示", () => {
    expect(
      isAwaitingAuthorization({
        connectorStatus: "disconnected",
        attempt: undefined,
        attemptFailed: false,
        attemptInFlight: false,
      }),
    ).toBe(false);
  });
});
