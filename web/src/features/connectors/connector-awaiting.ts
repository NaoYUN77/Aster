import type { ConnectResult, ConnectorStatus } from "@/api/connectors";

/**
 * 是否显示“已发起授权，等待服务器确认”。
 *
 * 只有以下情况才算等待：
 * - 本轮已经拿到授权 URL 并成功调用 `openAuthUrl`（`attempt.status === "pending"`）；
 * - 或列表里该连接已经是 pending，且本轮没有报错、也没有正在请求。
 *
 * 单独的 pending 不能决定：`POST /connectors` 会先在服务端建出 pending 行，
 * 如果紧接着 `POST /oauth/start` 失败，界面不能继续显示“等待授权”。
 */
export function isAwaitingAuthorization(input: {
  connectorStatus: ConnectorStatus;
  attempt?: ConnectResult;
  attemptFailed: boolean;
  attemptInFlight: boolean;
}): boolean {
  if (input.connectorStatus === "connected") return false;
  if (input.attemptFailed) return false;
  if (input.attemptInFlight) return false;
  return input.attempt?.status === "pending" || input.connectorStatus === "pending";
}
