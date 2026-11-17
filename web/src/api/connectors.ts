import { getApiConfig, notifyUnauthorized } from "./client";
import { ApiError, errorBodyOf, statusError, toApiError } from "./errors";

/**
 * Connectors 的临时前端接口层。
 *
 * Dev 1 的 Connector API 合同尚未落库，这里先固定一组最小形状，
 * 供 UI 与 mock 使用；合同稳定后只需要替换本文件的 endpoint 与类型，
 * 页面与状态逻辑不动。路径约定：
 *
 * - GET  /api/v1/connectors
 * - POST /api/v1/connectors/{id}/connect
 * - POST /api/v1/connectors/{id}/disconnect
 * - POST /api/v1/credential-requests/{requestId}        body { token }
 * - POST /api/v1/credential-requests/{requestId}/cancel body { reason }
 *
 * 连接状态由服务端保存（一次授权、三端复用）；前端不持久化任何
 * Connector token / 账号密码，只缓存查询结果。
 */

export type ConnectorId = "github" | "gmail";

export type ConnectorStatus = "disconnected" | "connected" | "error";

export type ConnectorAccount = {
  /** 稳定的账号标识，例如 GitHub login 或邮箱。 */
  id: string;
  label: string;
  detail?: string | null;
};

export type Connector = {
  id: ConnectorId;
  name: string;
  description: string;
  status: ConnectorStatus;
  account: ConnectorAccount | null;
  scopes: string[];
  /** Gmail 本轮只读；UI 不展示发送/删除入口。 */
  readOnly: boolean;
  connectedAt: string | null;
  lastError: string | null;
};

export type ConnectorsResponse = {
  connectors: Connector[];
  /** 仅本地 mock 返回，用于显示“模拟凭据请求”入口。 */
  mock?: boolean;
};

export type CredentialRequest = {
  requestId: string;
  connector: { id: string; name: string };
  tool: string;
  scopes: string[];
  /** epoch 毫秒；服务端只给 ttl 时由 events.ts 换算。 */
  expiresAt: number;
  reason: string | null;
  accountHint: string | null;
};

export type CancelReason = "denied" | "cancelled" | "timeout";

/** 列表查询的根 key；SSE / 其他端变更时按前缀失效。 */
export const CONNECTORS_QUERY_ROOT = "connectors";

export function connectorsQueryKey(baseUrl: string) {
  return [CONNECTORS_QUERY_ROOT, baseUrl] as const;
}

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  window.setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function connectorRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { baseUrl, token } = getApiConfig();
  if (!baseUrl) {
    throw new ApiError("NETWORK_ERROR", "未配置服务器地址");
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
      cache: "no-store",
      signal: timeoutSignal(15_000),
    });
  } catch (error) {
    throw toApiError(error);
  }

  if (response.status === 204) return undefined as T;

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    const errorBody = errorBodyOf(body);
    if (errorBody) {
      throw new ApiError(errorBody.code, errorBody.message, response.status);
    }
    throw statusError(response.status);
  }

  return body as T;
}

function connectorOf(value: unknown): Connector | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { connector?: unknown };
  const candidate = record.connector ?? value;
  if (typeof candidate !== "object" || candidate === null) return null;
  const connector = candidate as Partial<Connector>;
  if (typeof connector.id !== "string" || typeof connector.status !== "string") {
    return null;
  }
  return candidate as Connector;
}

export type ConnectResult =
  | { status: "connected"; connector: Connector }
  | { status: "pending" };

export async function listConnectors(): Promise<ConnectorsResponse> {
  const data = await connectorRequest<ConnectorsResponse>("/api/v1/connectors");
  return {
    connectors: Array.isArray(data?.connectors) ? data.connectors : [],
    ...(data?.mock === true ? { mock: true } : {}),
  };
}

export async function connectConnector(id: ConnectorId): Promise<ConnectResult> {
  const data = await connectorRequest<unknown>(`/api/v1/connectors/${id}/connect`, {
    method: "POST",
  });
  const connector = connectorOf(data);
  if (connector) return { status: "connected", connector };

  // 服务端需要走 OAuth 回调时可能先返回 pending；前端只等待，
  // 不弹出独立 OAuth 窗口，连接完成由 `connector.changed` 通知。
  const record = (data ?? {}) as { status?: unknown };
  if (record.status === "pending" || record.status === "authorizing") {
    return { status: "pending" };
  }

  throw new ApiError("INVALID_RESPONSE", "服务器没有返回连接状态");
}

export async function disconnectConnector(id: ConnectorId): Promise<void> {
  await connectorRequest<unknown>(`/api/v1/connectors/${id}/disconnect`, {
    method: "POST",
  });
}

/** 明文 token 只在本函数内通过 HTTPS body 发给服务端，不落任何存储。 */
export async function submitCredential(requestId: string, token: string): Promise<void> {
  await connectorRequest<unknown>(
    `/api/v1/credential-requests/${encodeURIComponent(requestId)}`,
    { method: "POST", body: JSON.stringify({ token }) },
  );
}

export async function cancelCredential(
  requestId: string,
  reason: CancelReason,
): Promise<void> {
  await connectorRequest<unknown>(
    `/api/v1/credential-requests/${encodeURIComponent(requestId)}/cancel`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

/** 仅 mock：让本地服务端推送一条 credential.request，便于三端验收弹窗。 */
export async function requestMockCredential(connectorId?: ConnectorId): Promise<void> {
  await connectorRequest<unknown>("/api/v1/mock/credential-request", {
    method: "POST",
    ...(connectorId ? { body: JSON.stringify({ connectorId }) } : {}),
  });
}
