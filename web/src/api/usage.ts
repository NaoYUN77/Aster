import { getApiConfig, notifyUnauthorized } from "./client";
import { ApiError, errorBodyOf, statusError, toApiError } from "./errors";

export type UsageSource = "main" | "subagent" | "dreaming" | "routine" | "compaction";
export type UsageRange = "1d" | "7d" | "30d";

export type ContextOccupancySnapshot = {
  usedTokens: number;
  contextWindow: number | null;
  ratio: number | null;
  provider: string | null;
  modelId: string | null;
  updatedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

export type UsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheHitRate: number | null;
  costUsd: number | null;
};

export type UsageTrendPoint = {
  key: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number | null;
};

export type UsageBySourceItem = {
  source: UsageSource;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  share: number;
  costUsd: number | null;
};

export type UsageByModelItem = {
  provider: string;
  modelId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number | null;
  totalTokens: number;
  share: number;
  costUsd: number | null;
};

export type UsageCallItem = {
  id: number;
  timestamp: number;
  source: UsageSource;
  subagentId: string | null;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number | null;
  durationMs: number | null;
  contextWindow: number | null;
};

export type UsageBudgetState = {
  dailyTokenBudget: number | null;
  todayTokens: number;
  lastAlertDate: string | null;
};

export type UsageSummaryResponse = {
  range: UsageRange;
  timezone: string;
  contextOccupancy: ContextOccupancySnapshot;
  totals: UsageTotals;
  trend: UsageTrendPoint[];
  bySource: UsageBySourceItem[];
  byModel: UsageByModelItem[];
  availableModels: { provider: string; modelId: string }[];
  recentCalls: UsageCallItem[];
  budget: UsageBudgetState;
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

export async function getUsageSummary(
  range: UsageRange,
  filters: { model?: string; source?: UsageSource } = {},
): Promise<UsageSummaryResponse> {
  const params = new URLSearchParams({ range });
  if (filters.model) params.set("model", filters.model);
  if (filters.source) params.set("source", filters.source);
  return requestJson<UsageSummaryResponse>(`/api/v1/usage?${params.toString()}`, {
    method: "GET",
  });
}

export async function updateDailyTokenBudget(
  dailyTokenBudget: number | null,
): Promise<{ budget: UsageBudgetState }> {
  return requestJson<{ budget: UsageBudgetState }>("/api/v1/usage/budget", {
    method: "POST",
    body: JSON.stringify({ dailyTokenBudget }),
  });
}
