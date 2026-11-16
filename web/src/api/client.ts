import createClient from "openapi-fetch";
import type { paths } from "./schema";
import { ApiError, isErrorBody, statusError, toApiError } from "./errors";
import type {
  HealthResponse,
  LoginResponse,
  MeResponse,
  MessagePage,
  ModelsResponse,
  ModelSelectResponse,
} from "./types";

export type ApiClient = ReturnType<typeof createClient<paths>>;

type ApiConfig = {
  baseUrl: string;
  token: string | null;
};

let config: ApiConfig = { baseUrl: "", token: null };
let unauthorizedHandler: (() => void) | null = null;

export function configureApi(next: Partial<ApiConfig>): void {
  config = { ...config, ...next };
}

export function getApiConfig(): Readonly<ApiConfig> {
  return config;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function createApiClient(options: ApiConfig): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return createClient<paths>({
    baseUrl: `${baseUrl}/api/v1`,
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
  });
}

function api(): ApiClient {
  return createApiClient(config);
}

type FetchResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

async function unwrap<T>(promise: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await promise;
  } catch (error) {
    throw toApiError(error);
  }

  const { data, error, response } = result;

  if (response.ok) {
    return data as T;
  }

  if (response.status === 401) {
    unauthorizedHandler?.();
  }

  if (isErrorBody(error)) {
    throw new ApiError(error.code, error.message, response.status);
  }
  throw statusError(response.status);
}

function timeout(ms: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  window.setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/* ------------------------------------------------------------------ */
/* 无鉴权：健康检查                                                     */
/* ------------------------------------------------------------------ */

export async function checkHealth(baseUrl: string, timeoutMs = 8000): Promise<HealthResponse> {
  const client = createApiClient({ baseUrl, token: null });
  const startedAt = performance.now();
  const data = await unwrap<HealthResponse>(
    client.GET("/health", { signal: timeout(timeoutMs) }) as Promise<FetchResult<HealthResponse>>,
  );
  if (!data || data.ok !== true) {
    throw new ApiError("UNHEALTHY", "服务器健康检查未通过", 0);
  }
  // 延迟由调用方按需计算；这里仅作为连通性验证。
  void startedAt;
  return data;
}

/* ------------------------------------------------------------------ */
/* 认证                                                                */
/* ------------------------------------------------------------------ */

export async function login(password: string): Promise<LoginResponse> {
  return unwrap<LoginResponse>(
    api().POST("/auth/login", {
      body: { password },
      signal: timeout(15_000),
    }) as Promise<FetchResult<LoginResponse>>,
  );
}

export async function logout(): Promise<void> {
  await unwrap<undefined>(
    api().POST("/auth/logout", { signal: timeout(10_000) }) as Promise<FetchResult<undefined>>,
  );
}

export async function me(): Promise<MeResponse> {
  return unwrap<MeResponse>(
    api().GET("/auth/me", { signal: timeout(10_000) }) as Promise<FetchResult<MeResponse>>,
  );
}

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

export async function listMessages(before?: string | null, limit = 30): Promise<MessagePage> {
  return unwrap<MessagePage>(
    api().GET("/messages", {
      params: { query: { ...(before ? { before } : {}), limit } },
      signal: timeout(20_000),
    }) as Promise<FetchResult<MessagePage>>,
  );
}

export async function sendMessage(input: {
  clientMessageId: string;
  text: string;
}): Promise<{ requestId: string; status: "queued" }> {
  return unwrap<{ requestId: string; status: "queued" }>(
    api().POST("/messages", {
      body: input,
      signal: timeout(20_000),
    }) as Promise<FetchResult<{ requestId: string; status: "queued" }>>,
  );
}

export async function abortRequest(requestId: string): Promise<void> {
  await unwrap<unknown>(
    api().POST("/requests/{requestId}/abort", {
      params: { path: { requestId } },
      signal: timeout(10_000),
    }) as Promise<FetchResult<unknown>>,
  );
}

/* ------------------------------------------------------------------ */
/* 模型                                                                */
/* ------------------------------------------------------------------ */

export async function listModels(): Promise<ModelsResponse> {
  return unwrap<ModelsResponse>(
    api().GET("/models", { signal: timeout(15_000) }) as Promise<FetchResult<ModelsResponse>>,
  );
}

export async function selectModel(modelId: string): Promise<ModelSelectResponse> {
  return unwrap<ModelSelectResponse>(
    api().POST("/models/select", {
      body: { action: "select", modelId },
      signal: timeout(15_000),
    }) as Promise<FetchResult<ModelSelectResponse>>,
  );
}

export async function selectPrimaryModel(): Promise<ModelSelectResponse> {
  return unwrap<ModelSelectResponse>(
    api().POST("/models/select", {
      body: { action: "primary" },
      signal: timeout(15_000),
    }) as Promise<FetchResult<ModelSelectResponse>>,
  );
}

export function sseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/v1/events`;
}
