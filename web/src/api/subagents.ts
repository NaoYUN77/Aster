import { getApiConfig, notifyUnauthorized } from "./client";
import { ApiError, errorBodyOf, statusError, toApiError } from "./errors";

export type SubagentStatus =
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type SubagentSnapshot = {
  id: string;
  task: string;
  status: SubagentStatus;
  currentTool: string | null;
  startedAt: number;
  finishedAt: number | null;
  error?: string;
};

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { baseUrl, token } = getApiConfig();
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    throw toApiError(error);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.ok) return body as T;
  if (response.status === 401) notifyUnauthorized();
  const errBody = errorBodyOf(body);
  if (errBody) throw new ApiError(errBody.code, errBody.message, response.status);
  throw statusError(response.status);
}

export async function listSubagents(): Promise<{ items: SubagentSnapshot[] }> {
  return requestJson<{ items: SubagentSnapshot[] }>("/api/v1/subagents", {
    method: "GET",
  });
}

export async function cancelSubagent(
  subagentId: string,
): Promise<{ id: string; status: string }> {
  return requestJson<{ id: string; status: string }>(
    `/api/v1/subagents/${encodeURIComponent(subagentId)}/cancel`,
    { method: "POST" },
  );
}
