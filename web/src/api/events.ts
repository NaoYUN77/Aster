import { z } from "zod";
import type { ModelKind, ModelRef, ModelUsage, UiMessage } from "./types";

const modelRefSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string().optional(),
  label: z.string(),
});

const modelKindSchema = z.enum(["primary", "manual", "auto"]);

const modelUsageSchema = z.object({
  requested: modelRefSchema.extend({ kind: modelKindSchema.optional() }).nullish(),
  actual: modelRefSchema.nullish(),
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
  model: modelRefSchema.nullish(),
  errorCode: z.string().nullish(),
  tool: z
    .object({ name: z.string(), status: z.enum(["done", "failed"]) })
    .nullish(),
});

const snapshotSchema = z.object({
  activeRequest: z
    .object({
      requestId: z.string(),
      status: z.string().optional(),
      clientMessageId: z.string().optional(),
    })
    .nullish(),
  modelVersion: z.number().optional(),
});

const queuedSchema = z.object({
  requestId: z.string(),
  clientMessageId: z.string(),
});

const runningSchema = z.object({ requestId: z.string() });

const doneSchema = z.object({
  requestId: z.string(),
  message: uiMessageSchema,
  model: modelUsageSchema.optional(),
});

const failedSchema = z.object({
  requestId: z.string(),
  code: z.string().nullish(),
  message: z.string().nullish(),
});

const abortedSchema = z.object({ requestId: z.string() });

const modelChangedSchema = z.object({
  current: z.object({
    provider: z.string().optional(),
    id: z.string(),
    name: z.string().optional(),
    label: z.string(),
    kind: modelKindSchema.optional(),
  }),
  version: z.number().optional(),
});

export type ParsedServerEvent =
  | {
      type: "snapshot";
      activeRequest: {
        requestId: string;
        status?: string;
        clientMessageId?: string;
      } | null;
      modelVersion?: number;
    }
  | { type: "request.queued"; requestId: string; clientMessageId: string }
  | { type: "request.running"; requestId: string }
  | { type: "request.done"; requestId: string; message: UiMessage; usage: ModelUsage }
  | { type: "request.failed"; requestId: string; code: string | null; message: string | null }
  | { type: "request.aborted"; requestId: string }
  | { type: "model.changed"; current: ModelRef; version?: number }
  | { type: "ignored"; event: string };

function fallbackUsage(message: UiMessage): ModelUsage {
  const actual = message.model ?? undefined;
  const kind: ModelKind = "primary";
  return { requested: undefined, actual, kind, degraded: false };
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
      };
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
    case "model.changed": {
      const parsed = modelChangedSchema.safeParse(data);
      if (!parsed.success) return { type: "ignored", event };
      const current = parsed.data.current;
      return {
        type: "model.changed",
        current: {
          provider: current.provider ?? "unknown",
          id: current.id,
          label: current.label,
          ...(current.name ? { name: current.name } : {}),
        },
        ...(parsed.data.version !== undefined ? { version: parsed.data.version } : {}),
      };
    }
    default:
      return { type: "ignored", event };
  }
}
