import { getApiConfig, notifyUnauthorized } from "./client";
import { ApiError, errorBodyOf, statusError, toApiError } from "./errors";

export type ApprovalRuleId =
  | "destructive_shell"
  | "workspace_escape"
  | "external_write"
  | "subagent_write_escalation";

export type ApprovalCaller =
  | { kind: "main"; conversationId: string }
  | { kind: "subagent"; subagentId: string; task: string };

export type ApprovalDecision = "approve_once" | "approve_similar" | "deny";

export type ApprovalStatus =
  | "pending"
  | "approved_once"
  | "approved_similar"
  | "denied"
  | "expired"
  | "aborted"
  | "interrupted";

export type ApprovalRequestView = {
  id: string;
  status: ApprovalStatus;
  caller: ApprovalCaller;
  toolName: string;
  args: unknown;
  rule: ApprovalRuleId;
  reason: string;
  categoryKey: string;
  summary: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  decisionReason: string | null;
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

export async function listApprovals(): Promise<{ items: ApprovalRequestView[] }> {
  return requestJson<{ items: ApprovalRequestView[] }>("/api/v1/approvals", {
    method: "GET",
  });
}

export async function resolveApproval(
  approvalId: string,
  input: { decision: ApprovalDecision; reason?: string },
): Promise<{ approval: ApprovalRequestView }> {
  return requestJson<{ approval: ApprovalRequestView }>(
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}
