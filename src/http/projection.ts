import { contentText, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { AssistantEntry, ToolResultEntry, UserEntry, type EntryRecord } from "@earendil-works/pi-durable";
import { MODEL_INCOMPATIBLE_MESSAGE, MODEL_UNAVAILABLE_MESSAGE } from "../model-failover.js";

/**
 * Projection from the durable transcript to the UI message shape.
 *
 * The transcript is the only history source; nothing is copied into a second message table. One
 * entry becomes one UI message (or is hidden). Tool entries keep only a name and a coarse status,
 * never arguments or raw output.
 */

/**
 * A host-initiated notification (reminder, watch event, routine result). It is a durable entry so it
 * appears in history in order and survives a restart; it carries no model messages, so it never
 * enters the model's context.
 */
export const WEB_HOST_MESSAGE_KIND = "web.host-message";

export type HostMessageSource = "reminder" | "watch" | "routine";

export type UiMessage = {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: number;
  readonly status: "complete" | "failed" | "aborted";
  readonly requestId: string | null;
  /** Web idempotency key for the request that produced this message; null outside the web adapter. */
  readonly clientMessageId: string | null;
  readonly model: { readonly id: string; readonly label: string; readonly provider: string } | null;
  readonly errorCode: string | null;
  readonly tool: { readonly name: string; readonly status: "done" | "failed" } | null;
};

export type HistoryPage = {
  readonly messages: readonly UiMessage[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

function modelOf(message: AssistantMessage): UiMessage["model"] {
  return {
    id: message.model,
    label: `${message.provider}/${message.model}`,
    provider: message.provider,
  };
}

function statusOf(message: AssistantMessage): UiMessage["status"] {
  if (message.stopReason === "aborted") return "aborted";
  if (message.stopReason === "error") return "failed";
  return "complete";
}

function errorCodeOf(message: AssistantMessage): string | null {
  if (message.stopReason !== "error") return null;
  if (message.errorMessage === MODEL_UNAVAILABLE_MESSAGE) return "MODEL_UNAVAILABLE";
  if (message.errorMessage === MODEL_INCOMPATIBLE_MESSAGE) return "MODEL_INCOMPATIBLE";
  return "MODEL_ERROR";
}

/** Fallback text for a failed assistant turn whose content itself is empty. */
function failedText(message: AssistantMessage): string {
  if (message.errorMessage === MODEL_UNAVAILABLE_MESSAGE) return MODEL_UNAVAILABLE_MESSAGE;
  if (message.errorMessage === MODEL_INCOMPATIBLE_MESSAGE) return MODEL_INCOMPATIBLE_MESSAGE;
  return "";
}

function assistantMessages(entry: EntryRecord): AssistantMessage[] {
  return (entry.model ?? []).filter((message): message is AssistantMessage => message.role === "assistant");
}

function projectUser(entry: EntryRecord): UiMessage | undefined {
  const message = (entry.model ?? [])[0];
  if (message === undefined || message.role !== "user") return undefined;
  const text = contentText(message.content).trim();
  if (text === "") return undefined;
  return {
    id: String(entry.id),
    role: "user",
    text,
    createdAt: message.timestamp,
    status: "complete",
    requestId: null,
    clientMessageId: null,
    model: null,
    errorCode: null,
    tool: null,
  };
}

function projectAssistant(entry: EntryRecord): UiMessage | undefined {
  const messages = assistantMessages(entry);
  const last = messages.at(-1);
  if (last === undefined) return undefined;
  const text = messages.map((message) => contentText(message.content)).join("").trim();
  const status = statusOf(last);
  // A stopped generation with no visible text is bookkeeping, not a message: showing it would
  // leave an empty assistant bubble. A partial stopped answer is still shown as aborted.
  if (text === "" && (status === "complete" || status === "aborted")) return undefined;
  return {
    id: String(entry.id),
    role: "assistant",
    text: text === "" ? failedText(last) : text,
    createdAt: last.timestamp,
    status,
    requestId: null,
    clientMessageId: null,
    model: modelOf(last),
    errorCode: errorCodeOf(last),
    tool: null,
  };
}

function projectTool(entry: EntryRecord): UiMessage | undefined {
  const message = (entry.model ?? [])[0];
  if (message === undefined || message.role !== "toolResult") return undefined;
  return {
    id: String(entry.id),
    role: "assistant",
    text: "",
    createdAt: message.timestamp,
    status: "complete",
    requestId: null,
    clientMessageId: null,
    model: null,
    errorCode: null,
    tool: { name: message.toolName, status: message.isError ? "failed" : "done" },
  };
}

/**
 * Host notifications are written by this process, not by a model. Only the text and a coarse source
 * survive the projection; any internal key used for idempotency stays in storage.
 */
function projectHostMessage(entry: EntryRecord): UiMessage | undefined {
  if (entry.kind !== WEB_HOST_MESSAGE_KIND) return undefined;
  const data = entry.data as { readonly text?: unknown; readonly source?: unknown; readonly createdAt?: unknown } | undefined;
  if (typeof data?.text !== "string") return undefined;
  const text = data.text.trim();
  if (text === "") return undefined;
  const createdAt = typeof data.createdAt === "number" && Number.isFinite(data.createdAt)
    ? data.createdAt
    : 0;
  return {
    id: String(entry.id),
    role: "system",
    text,
    createdAt,
    status: "complete",
    requestId: null,
    clientMessageId: null,
    model: null,
    errorCode: null,
    tool: null,
  };
}

/** One entry, or `undefined` for system/reset/compaction/internal entries that have no UI row. */
export function projectEntry(entry: EntryRecord): UiMessage | undefined {
  if (UserEntry.is(entry)) return projectUser(entry);
  if (AssistantEntry.is(entry)) return projectAssistant(entry);
  if (ToolResultEntry.is(entry)) return projectTool(entry);
  if (entry.kind === WEB_HOST_MESSAGE_KIND) return projectHostMessage(entry);
  return undefined;
}

export function projectEntries(entries: readonly EntryRecord[]): UiMessage[] {
  const messages: UiMessage[] = [];
  for (const entry of entries) {
    const message = projectEntry(entry);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

/** Text of the newest assistant message in an entry, if any (used to enrich `request.done`). */
export function assistantText(entry: EntryRecord): string | undefined {
  const messages = assistantMessages(entry);
  if (messages.length === 0) return undefined;
  return contentText(messages.flatMap((message) => message.content)).trim();
}

export type { Message };
