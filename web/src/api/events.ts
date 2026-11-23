import { z } from "zod";
import type { ApprovalRequestView } from "./approvals";
import type { CredentialRequest } from "./connectors";
import type { SubagentSnapshot } from "./subagents";
import type {
  ModelKind,
  ModelRef,
  ModelUsage,
  QueuedRequest,
  UiMessage,
} from "./types";

/** 目录里的模型条目（ModelEntry）：provider/id/name/label。 */
const modelEntrySchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  label: z.string(),
});

/** 消息/用量里携带的模型（MessageModel）：id/label，provider 可选。 */
const messageModelSchema = z.object({
  provider: z.string().optional(),
  id: z.string(),
  label: z.string(),
});

const modelKindSchema = z.enum(["primary", "manual", "auto"]);

const modelUsageSchema = z.object({
  requested: z.object({
    provider: z.string().optional(),
    id: z.string(),
    label: z.string(),
    kind: modelKindSchema,
  }),
  actual: messageModelSchema,
  kind: modelKindSchema,
  degraded: z.boolean(),
});

const uiMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  createdAt: z.number(),
  status: z.enum(["complete", "failed", "aborted"]),
  requestId: z.string().nullish(),
  // Dev 1 契约新增；旧服务端不返回。
  clientMessageId: z.string().nullish(),
  model: messageModelSchema.nullish(),
  errorCode: z.string().nullish(),
  tool: z
    .object({ name: z.string(), status: z.enum(["done", "failed"]) })
    .nullish(),
});

const queuedRequestSchema = z.object({
  requestId: z.string(),
  clientMessageId: z.string(),
  text: z.string(),
  createdAt: z.number(),
});

const approvalCallerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("main"), conversationId: z.string() }),
  z.object({ kind: z.literal("subagent"), subagentId: z.string(), task: z.string() }),
]);

const approvalRequestSchema = z.object({
  id: z.string(),
  status: z.enum([
    "pending",
    "approved_once",
    "approved_similar",
    "denied",
    "expired",
    "aborted",
    "interrupted",
  ]),
  caller: approvalCallerSchema,
  toolName: z.string(),
  args: z.unknown(),
  rule: z.enum([
    "destructive_shell",
    "workspace_escape",
    "external_write",
    "subagent_write_escalation",
  ]),
  reason: z.string(),
  categoryKey: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  resolvedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

const subagentSnapshotSchema = z.object({
  id: z.string(),
  task: z.string(),
  status: z.enum(["running", "waiting_approval", "completed", "failed", "cancelled"]),
  currentTool: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  error: z.string().optional(),
});

const snapshotSchema = z.object({
  activeRequest: z
    .object({
      requestId: z.string(),
      status: z.string().optional(),
      clientMessageId: z.string().optional(),
    })
    .nullish(),
  queue: z.array(queuedRequestSchema).optional(),
  modelVersion: z.number().optional(),
  pendingApprovals: z.array(approvalRequestSchema).optional(),
  activeSubagents: z.array(subagentSnapshotSchema).optional(),
});

const queueChangedSchema = z.object({
  items: z.array(queuedRequestSchema),
});

const queuedSchema = z.object({
  requestId: z.string(),
  clientMessageId: z.string(),
});

const runningSchema = z.object({ requestId: z.string() });

const doneSchema = z.object({
  requestId: z.string(),
  message: uiMessageSchema,
  model: modelUsageSchema,
});

const failedSchema = z.object({
  requestId: z.string(),
  code: z.string().nullish(),
  message: z.string().nullish(),
});

const abortedSchema = z.object({ requestId: z.string() });

/** 运行中插话被接纳；同一 clientMessageId 重放会带同一个 steerId。 */
const steeredSchema = z.object({
  requestId: z.string(),
  steerId: z.string(),
  clientMessageId: z.string(),
  text: z.string(),
  createdAt: z.number(),
});

/** 插话的提交落地并产生回答；message.id 可能与原始 request.done 相同。 */
const steerDoneSchema = z.object({
  requestId: z.string(),
  steerId: z.string(),
  message: uiMessageSchema,
});

const modelChangedSchema = z.object({
  current: modelEntrySchema.extend({ kind: modelKindSchema.optional() }),
  version: z.number().optional(),
});

/**
 * Connector 凭据请求。真实契约只携带 OAuth 连接身份和工具名：
 * `{connectionId, provider, slug, tool, requestId}`。OAuth 连接器不会在
 * 生产流程里产生该事件，弹窗只由 mock 入口触发；这里仍按契约解析，
 * 缺失的展示字段用安全默认值补齐。
 */
const credentialRequestSchema = z.object({
  requestId: z.string(),
  connectionId: z.string().optional(),
  provider: z.string(),
  slug: z.string(),
  tool: z.string(),
});

export type HostMessageSource = "reminder" | "watch" | "routine";

const hostMessageSchema = z.object({
  message: uiMessageSchema,
  source: z.enum(["reminder", "watch", "routine"]).optional(),
});

/** Connector 连接状态变化；只用于让前端刷新列表，不信任 payload。 */
const connectorChangedSchema = z.object({}).passthrough();

function connectorDisplayName(provider: string): string {
  if (provider === "github") return "GitHub";
  if (provider === "gmail") return "Gmail";
  return provider;
}

export type ParsedServerEvent =
  | {
      type: "snapshot";
      activeRequest: {
        requestId: string;
        status?: string;
        clientMessageId?: string;
      } | null;
      modelVersion?: number;
      queue?: QueuedRequest[];
      pendingApprovals?: ApprovalRequestView[];
      activeSubagents?: SubagentSnapshot[];
    }
  | { type: "queue.changed"; items: QueuedRequest[] }
  | { type: "request.queued"; requestId: string; clientMessageId: string }
  | { type: "request.running"; requestId: string }
  | { type: "request.done"; requestId: string; message: UiMessage; usage: ModelUsage }
  | { type: "request.failed"; requestId: string; code: string | null; message: string | null }
  | { type: "request.aborted"; requestId: string }
  | {
      type: "request.steered";
      requestId: string;
      steerId: string;
      clientMessageId: string;
      text: string;
      createdAt: number;
    }
  | { type: "steer.done"; requestId: string; steerId: string; message: UiMessage }
  | { type: "model.changed"; current: ModelRef; version?: number }
  | { type: "host.message"; message: UiMessage; source?: HostMessageSource }
  | { type: "connector.changed" }
  | { type: "credential.request"; request: CredentialRequest }
  | { type: "approval.requested"; approval: ApprovalRequestView }
  | { type: "approval.resolved"; approval: ApprovalRequestView }
  | { type: "subagent.updated"; subagent: SubagentSnapshot }
  | { type: "ignored"; event: string };

function fallbackUsage(message: UiMessage): ModelUsage {
  const actual = message.model ?? { id: "unknown", label: "未知模型" };
  const kind: ModelKind = "primary";
  return {
    requested: { id: actual.id, label: actual.label, kind },
    actual,
    kind,
    degraded: false,
  };
}

/** 把 SSE 线格式解析成受控的联合类型；未知或畸形事件返回 ignored，不抛异常。 */
export function parseServerEvent(event: string, data: unknown): ParsedServerEvent {
  if (event === "heartbeat") return { type: "ignored", event };

  switch (event) {
    case "snapshot": {
      const parsed = snapshotSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      return {
        type: "snapshot",
        activeRequest: parsed.data.activeRequest ?? null,
        ...(parsed.data.modelVersion !== undefined
          ? { modelVersion: parsed.data.modelVersion }
          : {}),
        ...(parsed.data.queue !== undefined ? { queue: parsed.data.queue } : {}),
        ...(parsed.data.pendingApprovals !== undefined
          ? { pendingApprovals: parsed.data.pendingApprovals as ApprovalRequestView[] }
          : {}),
        ...(parsed.data.activeSubagents !== undefined
          ? { activeSubagents: parsed.data.activeSubagents as SubagentSnapshot[] }
          : {}),
      };
    }
    case "queue.changed": {
      const parsed = queueChangedSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      return { type: "queue.changed", items: parsed.data.items };
    }
    case "request.queued": {
      const parsed = queuedSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      return { type: "request.queued", ...parsed.data };
    }
    case "request.running": {
      const parsed = runningSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      return { type: "request.running", ...parsed.data };
    }
    case "request.done": {
      const parsed = doneSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      const message = parsed.data.message as UiMessage;
      return {
        type: "request.done",
        requestId: parsed.data.requestId,
        message,
        usage: parsed.data.model ?? fallbackUsage(message),
      };
    }
    case "request.failed": {
      const parsed = failedSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      return {
        type: "request.failed",
        requestId: parsed.data.requestId,
        code: parsed.data.code ?? null,
        message: parsed.data.message ?? null,
      };
    }
    case "request.aborted": {
      const parsed = abortedSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      return { type: "request.aborted", ...parsed.data };
    }
    case "request.steered": {
      const parsed = steeredSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      return { type: "request.steered", ...parsed.data };
    }
    case "steer.done": {
      const parsed = steerDoneSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      return {
        type: "steer.done",
        requestId: parsed.data.requestId,
        steerId: parsed.data.steerId,
        message: parsed.data.message as UiMessage,
      };
    }
    case "model.changed": {
      const parsed = modelChangedSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      const current = parsed.data.current;
      return {
        type: "model.changed",
        current: {
          provider: current.provider,
          id: current.id,
          label: current.label,
          name: current.name,
        },
        ...(parsed.data.version !== undefined ? { version: parsed.data.version } : {}),
      };
    }
    case "connector.changed": {
      const parsed = connectorChangedSchema.safeParse(data);
      return parsed.success ? { type: "connector.changed" } : { type: "ignored", event };
    }
    case "host.message": {
      const parsed = hostMessageSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      return {
        type: "host.message",
        message: parsed.data.message as UiMessage,
        ...(parsed.data.source ? { source: parsed.data.source } : {}),
      };
    }
    case "credential.request": {
      const parsed = credentialRequestSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      const value = parsed.data;
      return {
        type: "credential.request",
        request: {
          requestId: value.requestId,
          connector: {
            id: value.provider,
            name: connectorDisplayName(value.provider),
          },
          tool: value.tool,
          scopes: [],
          // 契约不带过期时间；mock 弹窗沿用 120 秒展示倒计时。
          expiresAt: Date.now() + 120_000,
          reason: null,
          accountHint: null,
        },
      };
    }
    case "approval.requested": {
      const parsed = approvalRequestSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      return { type: "approval.requested", approval: parsed.data as ApprovalRequestView };
    }
    case "approval.resolved": {
      const parsed = approvalRequestSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      return { type: "approval.resolved", approval: parsed.data as ApprovalRequestView };
    }
    case "subagent.updated": {
      const parsed = subagentSnapshotSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      return { type: "subagent.updated", subagent: parsed.data as SubagentSnapshot };
    }
    default:
      return { type: "ignored", event };
  }
}
