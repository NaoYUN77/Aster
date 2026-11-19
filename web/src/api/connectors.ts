import {
  openAuthUrl,
  type OpenAuthOutcome,
} from "@/lib/open-auth-url";
import { getApiConfig, notifyUnauthorized } from "./client";
import {
  ApiError,
  ERROR_CODE_TEXT,
  errorBodyOf,
  statusError,
  toApiError,
} from "./errors";
import type { components } from "./schema";

/**
 * Connectors API（按 Dev 1 后端真实契约）。
 *
 * - GET    /api/v1/connectors
 * - POST   /api/v1/connectors                        {provider, slug}
 * - POST   /api/v1/connectors/{slug}/oauth/start     -> {url}
 * - DELETE /api/v1/connectors/{slug}
 *
 * OAuth 回调由服务端处理；客户端只负责创建连接、打开系统浏览器并等待
 * `connector.changed` 或重新拉列表。连接 token 永远不进入客户端存储。
 *
 * credential.request 仅由 mock 入口触发。OAuth 连接器不会产生该事件，
 * 本文件也不再调用不存在的 `/credential-requests/*`。
 */

type ApiConnectorDefinition = components["schemas"]["ConnectorDefinition"];
type ApiConnectorConnection = components["schemas"]["ConnectorConnection"];
type ApiConnectorListResponse = components["schemas"]["ConnectorListResponse"];
type ApiCreateConnectorResponse = components["schemas"]["CreateConnectorResponse"];
type ApiOAuthStartResponse = components["schemas"]["OAuthStartResponse"];

export type ConnectorId =
  | "github"
  | "gmail"
  | "outlook"
  | "linear"
  | "notion"
  | "google_calendar"
  | "google_drive";

export type ConnectorStatus = "disconnected" | "pending" | "connected" | "error";

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
  /** 仅 mock 触发；真实 OAuth 连接器不会产生该事件。 */
  expiresAt: number;
  reason: string | null;
  accountHint: string | null;
};

export type CancelReason = "denied" | "cancelled" | "timeout";

export type ConnectResult = {
  status: "pending";
  /** Web 端保留授权地址作为手动兜底，UI 渲染可点击的「打开授权页」。 */
  manualAuthUrl: string | null;
};

/**
 * 授权启动失败时保留原始错误码，并标明是否需要在客户端清理 pending 行。
 *
 * 继承 ApiError，`toApiError` 会原样返回，错误码文案不受影响。
 */
export class ConnectorConnectError extends ApiError {
  readonly cleanupPending: boolean;

  constructor(cause: ApiError, cleanupPending: boolean) {
    super(
      cause.code,
      cause.message,
      cause.status,
      cause.requestStatus ? { requestStatus: cause.requestStatus } : {},
    );
    this.name = "ConnectorConnectError";
    this.cleanupPending = cleanupPending;
  }
}

/** 列表查询的根 key；SSE / 其他端变更时按前缀失效。 */
export const CONNECTORS_QUERY_ROOT = "connectors";

export function connectorsQueryKey(baseUrl: string) {
  return [CONNECTORS_QUERY_ROOT, baseUrl] as const;
}

const UI_PROVIDERS: ConnectorId[] = [
  "github",
  "gmail",
  "outlook",
  "linear",
  "notion",
  "google_calendar",
  "google_drive",
];

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

/** 连接器错误只展示客户端安全文案，不回显后端英文 message。 */
export function connectorErrorText(
  code: string | null | undefined,
  fallback = "连接器操作失败，请重试",
): string {
  if (code && ERROR_CODE_TEXT[code]) return ERROR_CODE_TEXT[code];
  return fallback;
}

function connectionForProvider(
  connections: ApiConnectorConnection[],
  provider: ConnectorId,
): ApiConnectorConnection | null {
  return (
    connections.find((item) => item.provider === provider && item.slug === provider) ??
    connections.find((item) => item.provider === provider) ??
    null
  );
}

function mapStatus(status: ApiConnectorConnection["status"]): ConnectorStatus {
  switch (status) {
    case "connected":
      return "connected";
    case "pending":
      return "pending";
    case "error":
      return "error";
    case "revoked":
    default:
      return "disconnected";
  }
}

const DISPLAY_NAMES: Record<ConnectorId, string> = {
  github: "GitHub",
  gmail: "Gmail",
  outlook: "Outlook",
  linear: "Linear",
  notion: "Notion",
  google_calendar: "Google Calendar",
  google_drive: "Google Drive",
};

function displayNameOf(
  provider: ConnectorId,
  definition: ApiConnectorDefinition | undefined,
): string {
  return definition?.displayName || DISPLAY_NAMES[provider];
}

/**
 * 把 `{providers, connections}` 映射成卡片模型。
 * 同一个 provider 有多条连接时优先 slug===provider（客户端固定使用该 slug）。
 */
export function mapConnectorList(
  response: ApiConnectorListResponse,
): Connector[] {
  // 用 string 作 key：新 provider 可能先于 OpenAPI 重新生成上线。
  const definitions = new Map<string, ApiConnectorDefinition>();
  for (const definition of response.providers) {
    definitions.set(definition.provider, definition);
  }

  return UI_PROVIDERS.map((provider) => {
    const definition = definitions.get(provider);
    const connection = connectionForProvider(response.connections, provider);
    const accountLabel = connection?.accountLabel?.trim() ?? "";

    return {
      id: provider,
      name: displayNameOf(provider, definition),
      description: "",
      status: connection ? mapStatus(connection.status) : "disconnected",
      account: accountLabel
        ? { id: accountLabel, label: accountLabel }
        : null,
      scopes:
        connection?.scopes ??
        definition?.defaultScopes ??
        [],
      connectedAt: connection?.createdAt ?? null,
      lastError: connection?.lastErrorCode
        ? connectorErrorText(connection.lastErrorCode, "连接异常，请重新授权")
        : null,
    };
  });
}

export async function listConnectors(): Promise<ConnectorsResponse> {
  const data = await connectorRequest<
    ApiConnectorListResponse & { mock?: boolean }
  >("/api/v1/connectors");
  if (!data || !Array.isArray(data.providers) || !Array.isArray(data.connections)) {
    throw new ApiError("INVALID_RESPONSE", "服务器返回了无法识别的连接器数据", 502);
  }
  return {
    connectors: mapConnectorList(data),
    ...(data.mock === true ? { mock: true } : {}),
  };
}

/** 幂等创建：已存在同一 provider/slug 时服务端返回 200 + created:false。 */
export async function createConnector(
  id: ConnectorId,
): Promise<ApiCreateConnectorResponse> {
  return connectorRequest<ApiCreateConnectorResponse>("/api/v1/connectors", {
    method: "POST",
    body: JSON.stringify({ provider: id, slug: id }),
  });
}

export async function startConnectorOAuth(
  id: ConnectorId,
): Promise<ApiOAuthStartResponse> {
  return connectorRequest<ApiOAuthStartResponse>(
    `/api/v1/connectors/${encodeURIComponent(id)}/oauth/start`,
    { method: "POST" },
  );
}

export async function deleteConnector(id: ConnectorId): Promise<void> {
  await connectorRequest<undefined>(
    `/api/v1/connectors/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

/**
 * 先创建连接，再拿授权 URL，交给 `openAuthUrl` 用设备默认浏览器打开。
 *
 * 本端只进入 pending；是否真正连接以 `connector.changed` / 重新拉列表为准。
 * Web 端返回 `manualAuthUrl` 作为兜底链接，绝不当前页跳转。
 */
export async function connectConnector(
  id: ConnectorId,
  openUrl: (url: string) => Promise<OpenAuthOutcome> = openAuthUrl,
): Promise<ConnectResult> {
  let cleanupPending = false;

  try {
    const created = await createConnector(id);
    // 只清理由本次流程建出来的行；已连接的旧连接失败时绝不能删。
    const status = created.connection?.status;
    cleanupPending =
      created.created === true ||
      (status !== undefined && status !== "connected");

    const { url } = await startConnectorOAuth(id);
    if (typeof url !== "string" || url.trim() === "") {
      throw new ApiError("INVALID_RESPONSE", "服务器没有返回授权地址", 502);
    }
    const outcome = await openUrl(url);
    return {
      status: "pending",
      manualAuthUrl: outcome === "manual" ? url : null,
    };
  } catch (error) {
    throw new ConnectorConnectError(toApiError(error), cleanupPending);
  }
}

/** 仅 mock：让本地 mock 服务端推送一条 credential.request，便于三端验收弹窗。 */
export async function requestMockCredential(connectorId?: ConnectorId): Promise<void> {
  await connectorRequest<unknown>("/api/v1/mock/credential-request", {
    method: "POST",
    ...(connectorId ? { body: JSON.stringify({ connectorId }) } : {}),
  });
}
