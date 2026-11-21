// Activity digest: the evidence layer dreaming reads from durable entries.
//
// Interface
//   buildActivityDigest(sources, options) -> bounded, redacted, day-grouped text and its cursor
//   redactActivityText(text)             -> text with credential-shaped values removed
//
// Input is one entry per durable transcript event, from every owner conversation, after the
// previous run's entry-id cursor. Output is plain text: real user and assistant text, tool-call
// names with an argument summary, tool results, and errors, grouped by event day. System
// messages, compactions, resets and application entries are not activity and are skipped.
//
// Two hard rules:
//   * A credential never enters the digest. Every rendered value is redacted for key/value
//     assignments, bearer tokens, private-key blocks and the common provider token shapes before
//     it is truncated, so a secret cannot be half-cut into the output.
//   * The digest is bounded from the newest line backwards. Old evidence is dropped whole; a
//     line is never rendered partially to fit the cap.
//
// The module is pure: no I/O, no SDK runtime surface, no clock. Callers supply the timezone and
// the entries; the cursor is the newest entry id among the supplied sources.

import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { AssistantEntry, ToolResultEntry, UserEntry, type ConversationId, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { eventDate, UNKNOWN_DATE } from "./contracts.js";

/** The whole digest is capped at this many estimated tokens, newest evidence first. */
export const ACTIVITY_MAX_TOKENS = 8_000;
/** One rendered line is bounded so a single message cannot crowd out everything else. */
export const ACTIVITY_LINE_MAX_CHARS = 600;
/** A tool call's arguments are a summary, never their full body. */
export const ACTIVITY_ARGUMENTS_MAX_CHARS = 240;
/** A tool result is evidence of what happened, not a copy of its payload. */
export const ACTIVITY_RESULT_MAX_CHARS = 400;

export type ActivitySource = {
  readonly conversationId: ConversationId;
  readonly entry: EntryRecord;
};

export type ActivityDigest = {
  /** Day-grouped evidence, oldest first; empty when the sources hold no activity. */
  readonly text: string;
  /** Newest supplied entry id, or null when there were no sources. */
  readonly through: EntryId | null;
  /** Distinct entries considered. */
  readonly entries: number;
  /** Activity lines kept after the token cap. */
  readonly lines: number;
  /** Activity lines dropped from the old end to fit the cap. */
  readonly dropped: number;
};

export type ActivityDigestOptions = {
  readonly timezone: string;
  readonly maxTokens?: number;
};

type ActivityLine = {
  readonly entryId: EntryId;
  readonly date: string;
  readonly text: string;
};

/** Redact credential-shaped values. Errs on the side of removing a harmless word over keeping a secret. */
export function redactActivityText(text: string): string {
  if (text === "") return text;
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu, "[redacted private key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(
      /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|secret|token|password|passwd|passphrase|credential|authorization))\b["']?(?:\s*[=:]\s*|\s+is\s+|\s+)["']?[^\s"'`,;&)}\]]+/giu,
      (_match, name: string) => `${name}=[redacted]`,
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[redacted]")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/gu, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16,}\b/gu, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/gu, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
}

/** One JSON-safe, single-line, redacted summary of a tool call's arguments. */
export function summarizeArguments(arguments_: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(arguments_);
  } catch {
    text = "[unrenderable arguments]";
  }
  if (text === undefined) text = "";
  return truncate(redactActivityText(text), ACTIVITY_ARGUMENTS_MAX_CHARS);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
}

function timestampOf(message: Message): number | undefined {
  const value = message.timestamp;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 8.64e15) return undefined;
  return value;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

function clock(timestamp: number | undefined, timezone: string): string {
  if (timestamp === undefined) return "unknown";
  let formatter = clockFormatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    clockFormatters.set(timezone, formatter);
  }
  return formatter.format(timestamp);
}

/**
 * The lines one entry contributes, each dated by its own message timestamp. An entry that carries
 * no activity (system, compaction, reset, application data, an empty message) yields none.
 */
function entryLines(entry: EntryRecord, timezone: string): Omit<ActivityLine, "entryId">[] {
  if (entry.kind !== UserEntry.kind && entry.kind !== AssistantEntry.kind && entry.kind !== ToolResultEntry.kind) return [];
  const lines: Omit<ActivityLine, "entryId">[] = [];
  for (const message of entry.model ?? []) {
    if (message.role === "user") {
      const text = messageText(message);
      const rendered = truncate(redactActivityText(text), ACTIVITY_LINE_MAX_CHARS);
      if (rendered !== "") {
        const timestamp = timestampOf(message);
        lines.push({ date: eventDate(timestamp, timezone), text: `[${clock(timestamp, timezone)}] user: ${rendered}` });
      }
      continue;
    }
    if (message.role === "assistant") {
      const timestamp = timestampOf(message);
      const date = eventDate(timestamp, timezone);
      const at = clock(timestamp, timezone);
      const text = truncate(redactActivityText(messageText(message)), ACTIVITY_LINE_MAX_CHARS);
      if (text !== "") lines.push({ date, text: `[${at}] assistant: ${text}` });
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        const summary = summarizeArguments(part.arguments);
        lines.push({ date, text: truncate(`[${at}] tool ${part.name}: ${summary}`, ACTIVITY_LINE_MAX_CHARS) });
      }
      if (message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage !== undefined) {
        const detail = truncate(redactActivityText(message.errorMessage ?? message.stopReason), ACTIVITY_LINE_MAX_CHARS);
        lines.push({ date, text: `[${at}] error: ${detail}` });
      }
      continue;
    }
    if (message.role === "toolResult") {
      const timestamp = timestampOf(message);
      const date = eventDate(timestamp, timezone);
      const at = clock(timestamp, timezone);
      const outcome = message.isError ? "error" : "ok";
      const text = truncate(redactActivityText(messageText(message)), ACTIVITY_RESULT_MAX_CHARS);
      const body = text === "" ? "(no text)" : text;
      lines.push({ date, text: truncate(`[${at}] tool-result ${message.toolName} (${outcome}): ${body}`, ACTIVITY_LINE_MAX_CHARS) });
    }
  }
  return lines;
}

/** Render day groups for a contiguous run of lines, oldest first. */
function render(lines: readonly ActivityLine[]): string {
  const blocks: string[] = [];
  let currentDate: string | null = null;
  let current: string[] = [];
  for (const item of lines) {
    if (item.date !== currentDate) {
      if (currentDate !== null) blocks.push(`## ${currentDate}\n${current.join("\n")}`);
      currentDate = item.date;
      current = [];
    }
    current.push(item.text);
  }
  if (currentDate !== null) blocks.push(`## ${currentDate}\n${current.join("\n")}`);
  return blocks.join("\n\n");
}

/**
 * Build the digest. Sources are deduplicated by entry id and ordered by entry id, so a fork that
 * repeats its parent's entries contributes each event once.
 */
export function buildActivityDigest(sources: readonly ActivitySource[], options: ActivityDigestOptions): ActivityDigest {
  const maxTokens = options.maxTokens ?? ACTIVITY_MAX_TOKENS;
  const seen = new Set<EntryId>();
  const ordered: ActivitySource[] = [];
  for (const source of sources) {
    if (seen.has(source.entry.id)) continue;
    seen.add(source.entry.id);
    ordered.push(source);
  }
  ordered.sort((left, right) => left.entry.id - right.entry.id);
  const through = ordered.length === 0 ? null : ordered[ordered.length - 1]!.entry.id;

  const lines: ActivityLine[] = [];
  for (const source of ordered) {
    for (const item of entryLines(source.entry, options.timezone)) {
      lines.push({ entryId: source.entry.id, ...item });
    }
  }

  // Keep a contiguous suffix, newest first. A day header is charged when the suffix first enters
  // that day, so a partially kept day still renders under its date.
  const kept: ActivityLine[] = [];
  let used = 0;
  let previousDate: string | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const item = lines[index]!;
    const header = item.date !== previousDate ? estimateTextTokens(`## ${item.date}\n`) : 0;
    const cost = estimateTextTokens(`${item.text}\n`) + header;
    if (used + cost > maxTokens) break;
    used += cost;
    kept.push(item);
    previousDate = item.date;
  }
  kept.reverse();

  return {
    text: render(kept),
    through,
    entries: ordered.length,
    lines: kept.length,
    dropped: lines.length - kept.length,
  };
}
