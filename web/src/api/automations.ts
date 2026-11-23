import { getApiConfig, notifyUnauthorized } from "./client";
import { ApiError, errorBodyOf, statusError, toApiError } from "./errors";

export const AUTOMATIONS_QUERY_ROOT = "automations" as const;

export type RoutineMode = "notify" | "agent";
export type RoutineDelivery = "always" | "report";
export type RoutineStatus = "active" | "paused" | "stopped";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "suppressed" | "skipped";
export type RunTrigger = "schedule" | "manual";

export type RoutineSchedule =
  | { kind: "daily"; at: string }
  | { kind: "weekly"; days: number[]; at: string }
  | { kind: "every"; minutes: number; from?: string; to?: string };

export type RoutineRunItem = {
  id: number;
  routineId: number;
  runKey: string;
  trigger: RunTrigger;
  status: RunStatus;
  scheduledFor: string | null;
  notBefore: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  reply: string | null;
  errorCode: string | null;
  attempts: number;
  leaseUntil: string | null;
  createdAt: string;
};

export type RoutineItem = {
  id: number;
  chatId: string;
  title: string;
  timezone: string;
  mode: RoutineMode;
  brief: string | null;
  text: string | null;
  delivery: RoutineDelivery;
  status: RoutineStatus;
  conversationId: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  schedule: {
    routineId: number;
    kind: "daily" | "weekly" | "every";
    spec: RoutineSchedule;
    nextDueAt: string;
    lastRunAt: string | null;
  };
  recentRuns: RoutineRunItem[];
};

export type WatchKind = "github_run" | "github_pr" | "github_events" | "feed" | "x";
export type WatchDeliveryMode = "triage" | "direct";
export type SourceMode = "push" | "poll";
export type SourceStatus = "active" | "backoff" | "error" | "paused" | "stopped";

export type WatcherSourceItem = {
  id: number;
  watcherId: number;
  kind: WatchKind;
  location: string;
  mode: SourceMode;
  status: SourceStatus;
  intervalSec: number;
  nextCheckAt: string | null;
  reconcileAt: string | null;
  failures: number;
  lastError: string | null;
  lastCheckAt: string | null;
};

export type WatcherItem = {
  id: number;
  chatId: string;
  threadTs: string | null;
  kind: WatchKind;
  target: string;
  label: string;
  status: string;
  maxEventsPerHour: number;
  deliveryMode: WatchDeliveryMode;
  triagePrompt: string | null;
  createdAt: string;
  stoppedAt: string | null;
  source: WatcherSourceItem;
};

export type WatchDigestItem = {
  id: number;
  watcherId: number;
  eventId: number;
  chatId: string;
  threadTs: string | null;
  text: string;
  status: string;
  attempts: number;
  createdAt: string;
  triageAction?: string | null;
  triageReason?: string | null;
  triageUrgent?: boolean;
};

export type ReminderStatus =
  | "pending"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "cancelled";

export type ReminderItem = {
  id: number;
  chatId: string;
  ownerId: string;
  content: string;
  dueAt: string;
  timezone: string;
  createdAt: string;
  status: ReminderStatus;
  attempts: number;
  messageId: string | null;
  sentAt: string | null;
  failureCode: string | null;
};

export type AutomationsResponse = {
  routines: {
    enabled: boolean;
    paused: boolean;
    items: RoutineItem[];
  };
  watchers: {
    enabled: boolean;
    quietHours: string | null;
    digestTime: string;
    timezone: string;
    items: WatcherItem[];
    digest: {
      items: WatchDigestItem[];
    };
  };
  reminders: {
    enabled: boolean;
    items: ReminderItem[];
  };
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

export function getAutomations(): Promise<AutomationsResponse> {
  return requestJson<AutomationsResponse>("/api/v1/automations", { method: "GET" });
}

export function pauseRoutine(id: number): Promise<{ routine: RoutineItem }> {
  return requestJson<{ routine: RoutineItem }>(`/api/v1/routines/${id}/pause`, {
    method: "POST",
  });
}

export function resumeRoutine(id: number): Promise<{ routine: RoutineItem }> {
  return requestJson<{ routine: RoutineItem }>(`/api/v1/routines/${id}/resume`, {
    method: "POST",
  });
}

export function runRoutineNow(id: number): Promise<{ run: RoutineRunItem }> {
  return requestJson<{ run: RoutineRunItem }>(`/api/v1/routines/${id}/run-now`, {
    method: "POST",
  });
}

export function deleteRoutine(id: number): Promise<{ deleted: boolean; id: number }> {
  return requestJson<{ deleted: boolean; id: number }>(`/api/v1/routines/${id}`, {
    method: "DELETE",
  });
}

export function stopWatcher(id: number): Promise<{ stopped: boolean; id: number }> {
  return requestJson<{ stopped: boolean; id: number }>(`/api/v1/watchers/${id}/stop`, {
    method: "POST",
  });
}

export function flushWatchDigest(): Promise<{ count: number; text: string }> {
  return requestJson<{ count: number; text: string }>("/api/v1/watchers/digest/flush", {
    method: "POST",
  });
}

export function cancelReminder(id: number): Promise<{ reminder: ReminderItem }> {
  return requestJson<{ reminder: ReminderItem }>(`/api/v1/reminders/${id}/cancel`, {
    method: "POST",
  });
}
