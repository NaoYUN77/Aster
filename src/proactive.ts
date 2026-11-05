// Proactive Loop V1 domain: trigger/run state, decision schema, bounded context, and the
// in-process scheduler. The runner that talks to the pi-durable Harness lives in
// proactive-runner.ts; this module never calls a model.

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { eventDate } from "./memory/contracts.js";
import type { WorkingState } from "./memory/contracts.js";
import { beginConversationTrace } from "./trace.js";

/** Bounds of one proactive run. Every value is host configuration, never a model parameter. */
export type ProactiveLimits = {
  readonly maxPerDay: number;
  readonly maxToolCalls: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly contextMaxChars: number;
  readonly recentDays: number;
};

export const PROACTIVE_LIMITS: ProactiveLimits = {
  maxPerDay: 1,
  maxToolCalls: 20,
  maxTokens: 60_000,
  timeoutMs: 180_000,
  contextMaxChars: 12_000,
  recentDays: 3,
};

export type ProactiveConfig = ProactiveLimits & {
  /** Local HH:MM after which the once-daily trigger is created. */
  readonly dailyAt: string;
  /** IANA zone used for daily triggers and the local notify-acceptance quota day. */
  readonly timezone: string;
};

/** Keep one scheduler pass and one delivery reconciliation bounded. */
const IDLE_WAKE_MS = 30_000;
const SEEN_ITEMS_LIMIT = 3;

export type ProactiveItem = {
  readonly title: string;
  readonly url: string;
  readonly summary: string;
  readonly relevance: string;
};

export type ProactiveDecision =
  | {
      readonly decision: "notify";
      readonly items: readonly ProactiveItem[];
      readonly reason: string;
    }
  | {
      readonly decision: "skip";
      readonly reason: string;
    };

const PROACTIVE_TEXT_LIMITS = {
  title: 200,
  summary: 600,
  relevance: 300,
  reason: 400,
  url: 8_192,
} as const;

const ProactiveItemSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: PROACTIVE_TEXT_LIMITS.title }),
    url: Type.String({ minLength: 1, maxLength: PROACTIVE_TEXT_LIMITS.url }),
    summary: Type.String({ minLength: 1, maxLength: PROACTIVE_TEXT_LIMITS.summary }),
    relevance: Type.String({ minLength: 1, maxLength: PROACTIVE_TEXT_LIMITS.relevance }),
  },
  { additionalProperties: false },
);

/** The only shapes the host accepts from a proactive run. */
export const ProactiveDecisionSchema = Type.Union([
  Type.Object(
    {
      decision: Type.Literal("notify"),
      items: Type.Array(ProactiveItemSchema, { minItems: 1, maxItems: SEEN_ITEMS_LIMIT }),
      reason: Type.String({ minLength: 1, maxLength: PROACTIVE_TEXT_LIMITS.reason }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      decision: Type.Literal("skip"),
      reason: Type.String({ minLength: 1, maxLength: PROACTIVE_TEXT_LIMITS.reason }),
    },
    { additionalProperties: false },
  ),
]);

export type ParsedDecision =
  | { readonly ok: true; readonly value: ProactiveDecision }
  | { readonly ok: false; readonly code: string };

function characterCount(value: string): number {
  return [...value].length;
}

/** Model text is data. Normalize line endings and drop control characters that could split a message. */
function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim();
}

function cleanItem(item: ProactiveItem): ProactiveItem | undefined {
  const title = cleanText(item.title);
  const summary = cleanText(item.summary);
  const relevance = cleanText(item.relevance);
  const url = item.url.trim();
  if (!title || !summary || !relevance || !url) return undefined;
  if (characterCount(title) > PROACTIVE_TEXT_LIMITS.title
    || characterCount(summary) > PROACTIVE_TEXT_LIMITS.summary
    || characterCount(relevance) > PROACTIVE_TEXT_LIMITS.relevance) return undefined;
  return { title, url, summary, relevance };
}

/** A single fenced JSON block is accepted; prose around it is not. */
function unfence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline < 0 || !trimmed.endsWith("```")) return trimmed;
  return trimmed.slice(firstNewline + 1, -3).trim();
}

/**
 * Strict parse of the final assistant text. A schema failure is reported, never repaired with
 * defaults and never sent as plain text.
 */
export function parseProactiveDecision(text: string): ParsedDecision {
  const body = unfence(text);
  if (!body.startsWith("{") || !body.endsWith("}")) {
    return { ok: false, code: "PROACTIVE_DECISION_INVALID_JSON" };
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, code: "PROACTIVE_DECISION_INVALID_JSON" };
  }
  if (!Value.Check(ProactiveDecisionSchema, value)) {
    return { ok: false, code: "PROACTIVE_DECISION_SCHEMA" };
  }
  if (value.decision === "skip") {
    const reason = cleanText(value.reason);
    if (!reason) return { ok: false, code: "PROACTIVE_DECISION_SCHEMA" };
    return { ok: true, value: { decision: "skip", reason } };
  }
  const items: ProactiveItem[] = [];
  for (const raw of value.items) {
    const item = cleanItem(raw);
    if (item === undefined) return { ok: false, code: "PROACTIVE_DECISION_SCHEMA" };
    items.push(item);
  }
  const reason = cleanText(value.reason);
  if (!reason) return { ok: false, code: "PROACTIVE_DECISION_SCHEMA" };
  return { ok: true, value: { decision: "notify", items, reason } };
}

export type NormalizedUrl = {
  /** Canonical URL safe to show and deliver. */
  readonly url: string;
  /** Dedupe identity: the canonical URL without its fragment. */
  readonly key: string;
};

/** Absolute http(s), no credentials, no fragment; nothing else can become a delivered source. */
export function normalizeProactiveUrl(raw: string): NormalizedUrl | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  if (!url.hostname) return undefined;
  url.hash = "";
  return { url: url.href, key: url.href };
}

export type ProactiveContextSummary = {
  readonly preferences: number;
  readonly profile: number;
  readonly recent: number;
  readonly task: boolean;
  readonly bytes: number;
  readonly truncated: boolean;
};

export type RecentMemorySegment = {
  readonly date: string;
  readonly kind: string;
  readonly text: string;
};

export type ProactiveContextInput = {
  readonly state: WorkingState;
  readonly recent: readonly RecentMemorySegment[];
  readonly now: Date;
  readonly maxChars: number;
};

export type ProactiveContext = {
  /** JSON text handed to the background conversation as data. */
  readonly text: string;
  readonly revision: number;
  readonly summary: ProactiveContextSummary;
};

function textLength(value: unknown): number {
  return JSON.stringify(value).length;
}

/**
 * Bounded, read-only snapshot of the main conversation's memory. Priority is version and task,
 * then preferences (with their source), then profile, then recent daily segments. Trimming never
 * invents a value: a dropped field is absent from the rendered object and counted in the summary.
 */
export function buildProactiveContext(input: ProactiveContextInput): ProactiveContext {
  const nowMs = input.now.getTime();
  const preferences = input.state.preferences
    .filter((item) => item.expiresAt === null || item.expiresAt > nowMs)
    .map((item) => ({
      id: item.id,
      text: item.text,
      scope: item.scope,
      source: { conversationId: item.source.conversationId, entryId: item.source.entryId },
      expiresAt: item.expiresAt,
    }));
  const profile = input.state.profile.map((item) => ({
    id: item.id,
    text: item.text,
    category: item.category,
    evidence: item.evidence.map((ref) => ({ date: ref.date, id: ref.id, page: ref.page })),
  }));
  let recent = [...input.recent].slice(-20);
  const omittedFields = new Set<string>();
  if (recent.length < input.recent.length) omittedFields.add("recent");
  let task: Record<string, unknown> = { status: "none" };
  if (input.state.task.status === "active") {
    const active = input.state.task;
    task = {
      status: "active",
      goal: active.goal,
      scope: active.scope,
      constraints: [...active.constraints],
      progress: active.progress.map((item) => ({ text: item.text, status: item.status })),
      blockers: [...active.blockers],
      nextStep: active.nextStep,
      notes: active.notes,
    };
  }

  const render = () => ({
    version: input.state.version,
    revision: input.state.revision,
    task,
    preferences,
    profile,
    recent,
    ...(omittedFields.size > 0 ? { omittedFields: [...omittedFields] } : {}),
  });
  const fits = () => textLength(render()) <= input.maxChars;

  while (!fits() && recent.length > 0) {
    recent = recent.slice(1);
    omittedFields.add("recent");
  }
  while (!fits() && profile.length > 0) {
    profile.pop();
    omittedFields.add("profile");
  }
  while (!fits() && preferences.length > 0) {
    preferences.pop();
    omittedFields.add("preferences");
  }
  // Omit whole task fields, preserving the status and every remaining value verbatim.
  // In particular a missing goal never becomes an empty goal or an invented inactive task.
  for (const field of ["notes", "progress", "constraints", "scope", "blockers", "nextStep", "goal"]) {
    if (fits()) break;
    if (Object.hasOwn(task, field)) {
      delete task[field];
      omittedFields.add(`task.${field}`);
    }
  }
  if (!fits()) throw new RangeError("Proactive context limit cannot fit the snapshot metadata");

  const text = JSON.stringify(render());
  return {
    text,
    revision: input.state.revision,
    summary: {
      preferences: preferences.length,
      profile: profile.length,
      recent: recent.length,
      task: input.state.task.status === "active",
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: omittedFields.size > 0,
    },
  };
}

/** The text the host delivers. Titles and summaries are model output; the framing is host text. */
export function proactiveMessage(items: readonly ProactiveItem[]): string {
  const lines = [`主动发现（${items.length} 条）`];
  items.forEach((item, index) => {
    lines.push("", `${index + 1}. ${cleanText(item.title)}`, item.url, cleanText(item.summary), `为什么相关：${cleanText(item.relevance)}`);
  });
  return lines.join("\n");
}

export function localDate(now: Date, timezone: string): string {
  return eventDate(now.getTime(), timezone);
}

function localTime(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

export type RunStatus =
  | "queued"
  | "running"
  | "decided"
  | "delivering"
  | "delivered"
  | "skipped"
  | "failed"
  | "delivery_failed"
  | "delivery_uncertain";

export type TriggerKind = "daily" | "manual";

export interface ProactiveRun {
  readonly id: number;
  readonly triggerId: number;
  readonly triggerKey: string;
  readonly triggerKind: TriggerKind;
  readonly localDate: string;
  /** Local date when the host accepted notify; independent of trigger and delivery dates. */
  readonly quotaDate: string | null;
  readonly status: RunStatus;
  readonly conversationId: string | null;
  readonly submissionId: string | null;
  readonly memoryRevision: number | null;
  readonly contextSummary: string | null;
  readonly decision: "notify" | "skip" | null;
  readonly reason: string | null;
  readonly items: readonly ProactiveItem[];
  readonly toolCalls: number;
  readonly tokens: number;
  readonly deliveryRequestId: string | null;
  readonly deliveryStatus: string | null;
  readonly deliveryError: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly decidedAt: string | null;
  readonly completedAt: string | null;
}

function parseItems(value: unknown): ProactiveItem[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (item === null || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.title !== "string" || typeof record.url !== "string"
        || typeof record.summary !== "string" || typeof record.relevance !== "string") return [];
      return [{ title: record.title, url: record.url, summary: record.summary, relevance: record.relevance }];
    });
  } catch {
    return [];
  }
}

function row(value: unknown): ProactiveRun {
  const record = value as Record<string, unknown>;
  return Object.freeze({
    id: Number(record.id),
    triggerId: Number(record.triggerId),
    triggerKey: String(record.triggerKey),
    triggerKind: String(record.kind) as TriggerKind,
    localDate: String(record.localDate),
    quotaDate: record.quotaDate === null ? null : String(record.quotaDate),
    status: String(record.status) as RunStatus,
    conversationId: record.conversationId === null ? null : String(record.conversationId),
    submissionId: record.submissionId === null ? null : String(record.submissionId),
    memoryRevision: record.memoryRevision === null ? null : Number(record.memoryRevision),
    contextSummary: record.contextSummary === null ? null : String(record.contextSummary),
    decision: record.decision === null ? null : String(record.decision) as "notify" | "skip",
    reason: record.reason === null ? null : String(record.reason),
    items: parseItems(record.itemsJson),
    toolCalls: Number(record.toolCalls),
    tokens: Number(record.tokens),
    deliveryRequestId: record.deliveryRequestId === null ? null : String(record.deliveryRequestId),
    deliveryStatus: record.deliveryStatus === null ? null : String(record.deliveryStatus),
    deliveryError: record.deliveryError === null ? null : String(record.deliveryError),
    errorCode: record.errorCode === null ? null : String(record.errorCode),
    createdAt: String(record.createdAt),
    startedAt: record.startedAt === null ? null : String(record.startedAt),
    decidedAt: record.decidedAt === null ? null : String(record.decidedAt),
    completedAt: record.completedAt === null ? null : String(record.completedAt),
  });
}

/**
 * Durable proactive state. Every transition is a conditional update inside one immediate
 * transaction, so a restart, a repeated scheduler scan, or two CLI invocations cannot execute the
 * same trigger twice. The scheduler holds no business state of its own.
 */
export class ProactiveStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #limits: ProactiveLimits;
  readonly #timezone: string;

  constructor(path: string, options: {
    readonly now?: () => Date;
    readonly limits?: ProactiveLimits;
    readonly timezone?: string;
  } = {}) {
    this.#db = new DatabaseSync(path);
    this.#now = options.now ?? (() => new Date());
    this.#limits = options.limits ?? PROACTIVE_LIMITS;
    this.#timezone = options.timezone ?? "UTC";
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS proactive_triggers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        triggerKey TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('daily', 'manual')),
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proactive_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        triggerId INTEGER NOT NULL UNIQUE REFERENCES proactive_triggers(id) ON DELETE CASCADE,
        localDate TEXT NOT NULL,
        quotaDate TEXT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
          'queued', 'running', 'decided', 'delivering', 'delivered', 'skipped', 'failed',
          'delivery_failed', 'delivery_uncertain'
        )),
        conversationId TEXT,
        submissionId TEXT,
        memoryRevision INTEGER,
        contextSummary TEXT,
        decision TEXT CHECK (decision IN ('notify', 'skip') OR decision IS NULL),
        reason TEXT,
        itemsJson TEXT,
        toolCalls INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        deliveryRequestId TEXT,
        deliveryStatus TEXT,
        deliveryError TEXT,
        errorCode TEXT,
        createdAt TEXT NOT NULL,
        startedAt TEXT,
        decidedAt TEXT,
        completedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS proactive_runs_status ON proactive_runs(status, id);
      CREATE TABLE IF NOT EXISTS proactive_observed_urls (
        runId INTEGER NOT NULL REFERENCES proactive_runs(id) ON DELETE CASCADE,
        urlKey TEXT NOT NULL,
        url TEXT NOT NULL,
        PRIMARY KEY (runId, urlKey)
      );
      CREATE TABLE IF NOT EXISTS proactive_seen_urls (
        urlKey TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        runId INTEGER NOT NULL,
        createdAt TEXT NOT NULL
      );
    `);
    this.transaction(() => {
      const columns = this.#db.prepare("PRAGMA table_info(proactive_runs)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "quotaDate")) {
        this.#db.exec("ALTER TABLE proactive_runs ADD COLUMN quotaDate TEXT");
      }
      // Old accepted decisions already have an immutable UTC timestamp. Backfill once using
      // the configured zone; later restarts never reinterpret a persisted quota day.
      const legacy = this.#db.prepare(`SELECT id, decidedAt FROM proactive_runs
        WHERE decision = 'notify' AND quotaDate IS NULL AND decidedAt IS NOT NULL`)
        .all() as { id: number; decidedAt: string }[];
      const backfill = this.#db.prepare("UPDATE proactive_runs SET quotaDate = ? WHERE id = ? AND quotaDate IS NULL");
      for (const run of legacy) {
        backfill.run(localDate(new Date(run.decidedAt), this.#timezone), run.id);
      }
      this.#db.exec("CREATE INDEX IF NOT EXISTS proactive_runs_quota ON proactive_runs(quotaDate, decision)");
    });
  }

  get limits(): ProactiveLimits {
    return this.#limits;
  }

  /** Create a trigger and its queued run; the same trigger key returns the existing pair. */
  enqueueTrigger(input: {
    readonly kind: TriggerKind;
    readonly triggerKey?: string;
    readonly timezone: string;
    /** Host-computed push date; the scheduler passes the same value its due-time check used. */
    readonly localDate?: string;
  }): {
    readonly run: ProactiveRun;
    readonly created: boolean;
  } {
    const now = this.#now();
    const createdAt = now.toISOString();
    const key = input.triggerKey ?? `manual:${randomUUID()}`;
    const date = input.localDate ?? localDate(now, input.timezone);
    return this.transaction(() => {
      const inserted = this.#db.prepare(
        "INSERT OR IGNORE INTO proactive_triggers (triggerKey, kind, createdAt) VALUES (?, ?, ?)",
      ).run(key, input.kind, createdAt);
      const triggerId = Number((this.#db.prepare("SELECT id FROM proactive_triggers WHERE triggerKey = ?")
        .get(key) as { id: number }).id);
      if (inserted.changes === 0) {
        const existing = this.#db.prepare(`SELECT r.*, t.triggerKey, t.kind FROM proactive_runs r
          JOIN proactive_triggers t ON t.id = r.triggerId WHERE r.triggerId = ?`).get(triggerId);
        if (existing !== undefined) return { run: row(existing), created: false };
      }
      this.#db.prepare(`INSERT INTO proactive_runs (triggerId, localDate, status, createdAt)
        VALUES (?, ?, 'queued', ?)`).run(triggerId, date, createdAt);
      const run = this.#db.prepare(`SELECT r.*, t.triggerKey, t.kind FROM proactive_runs r
        JOIN proactive_triggers t ON t.id = r.triggerId WHERE r.triggerId = ?`).get(triggerId);
      return { run: row(run), created: true };
    });
  }

  /** Conditional `queued -> running`; only the winner executes the run. */
  claimNext(): ProactiveRun | undefined {
    return this.transaction(() => {
      const candidate = this.#db.prepare(
        "SELECT id FROM proactive_runs WHERE status = 'queued' ORDER BY id LIMIT 1",
      ).get() as { id: number } | undefined;
      if (candidate === undefined) return undefined;
      const changed = this.#db.prepare(
        "UPDATE proactive_runs SET status = 'running', startedAt = ? WHERE id = ? AND status = 'queued'",
      ).run(this.#now().toISOString(), candidate.id);
      if (changed.changes !== 1) return undefined;
      return this.get(candidate.id);
    });
  }

  get(id: number): ProactiveRun | undefined {
    const value = this.#db.prepare(`SELECT r.*, t.triggerKey, t.kind FROM proactive_runs r
      JOIN proactive_triggers t ON t.id = r.triggerId WHERE r.id = ?`).get(id);
    return value === undefined ? undefined : row(value);
  }

  list(limit = 100): ProactiveRun[] {
    const bounded = Math.max(1, Math.min(limit, 1_000));
    return (this.#db.prepare(`SELECT r.*, t.triggerKey, t.kind FROM proactive_runs r
      JOIN proactive_triggers t ON t.id = r.triggerId
      ORDER BY CASE r.status
        WHEN 'delivery_uncertain' THEN 0 WHEN 'running' THEN 1 WHEN 'decided' THEN 2
        WHEN 'delivering' THEN 3 WHEN 'queued' THEN 4 ELSE 5 END, r.id DESC LIMIT ?`)
      .all(bounded) as unknown[]).map(row);
  }

  /** Save the durable run identity. A crash before this leaves a run that can safely start over. */
  attachConversation(id: number, conversationId: string): void {
    const changed = this.#db.prepare(
      "UPDATE proactive_runs SET conversationId = ? WHERE id = ? AND status = 'running'",
    ).run(conversationId, id);
    if (changed.changes !== 1) throw new Error("Proactive run is not running");
  }

  attachSubmission(id: number, submissionId: string): void {
    const changed = this.#db.prepare(
      "UPDATE proactive_runs SET submissionId = ? WHERE id = ? AND status = 'running'",
    ).run(submissionId, id);
    if (changed.changes !== 1) throw new Error("Proactive run is not running");
  }

  recordContext(id: number, memoryRevision: number, summary: ProactiveContextSummary): void {
    this.#db.prepare(
      "UPDATE proactive_runs SET memoryRevision = ?, contextSummary = ? WHERE id = ? AND status = 'running'",
    ).run(memoryRevision, JSON.stringify(summary), id);
  }

  /** Progress is persisted after each tool/response so a restart keeps the same budget accounting. */
  recordProgress(id: number, progress: { readonly toolCalls: number; readonly tokens: number }): void {
    this.#db.prepare("UPDATE proactive_runs SET toolCalls = ?, tokens = ? WHERE id = ? AND status = 'running'")
      .run(progress.toolCalls, progress.tokens, id);
  }

  recordObservedUrls(id: number, urls: readonly NormalizedUrl[]): void {
    if (urls.length === 0) return;
    this.transaction(() => {
      const insert = this.#db.prepare(
        "INSERT OR IGNORE INTO proactive_observed_urls (runId, urlKey, url) VALUES (?, ?, ?)",
      );
      for (const url of urls) insert.run(id, url.key, url.url);
    });
  }

  observedUrls(id: number): NormalizedUrl[] {
    return (this.#db.prepare("SELECT urlKey, url FROM proactive_observed_urls WHERE runId = ?")
      .all(id) as { urlKey: string; url: string }[]).map((entry) => ({ key: entry.urlKey, url: entry.url }));
  }

  /** URLs already accepted for delivery, newest first; shown to the model so it can avoid repeats. */
  recentSeenUrls(limit = 50): string[] {
    const bounded = Math.max(1, Math.min(limit, 500));
    return (this.#db.prepare("SELECT url FROM proactive_seen_urls ORDER BY createdAt DESC, rowid DESC LIMIT ?")
      .all(bounded) as { url: string }[]).map((entry) => entry.url);
  }

  /**
   * Accept a notify decision after URL verification. The transaction re-checks the daily cap and
   * previously delivered URLs, records the seen URLs and the decision atomically. When nothing
   * survives the checks the run becomes an explicit skip, never a delivery.
   */
  acceptNotify(
    id: number,
    input: { readonly items: readonly ProactiveItem[]; readonly reason: string; readonly toolCalls: number; readonly tokens: number },
  ): ProactiveRun {
    return this.transaction(() => {
      const current = this.#db.prepare("SELECT id FROM proactive_runs WHERE id = ? AND status = 'running'").get(id);
      if (current === undefined) throw new Error("Proactive run is not running");
      const acceptedAt = this.#now();
      const quotaDate = localDate(acceptedAt, this.#timezone);
      const counted = Number((this.#db.prepare(`SELECT COUNT(*) AS n FROM proactive_runs
        WHERE quotaDate = ? AND decision = 'notify' AND id != ?`)
        .get(quotaDate, id) as { n: number }).n);
      if (counted >= this.#limits.maxPerDay) {
        return this.skipInTransaction(id, "daily-cap", input);
      }
      const seen = new Set((this.#db.prepare("SELECT urlKey FROM proactive_seen_urls").all() as { urlKey: string }[])
        .map((entry) => entry.urlKey));
      const kept: ProactiveItem[] = [];
      const keys = new Set<string>();
      for (const item of input.items) {
        const normalized = normalizeProactiveUrl(item.url);
        if (normalized === undefined || seen.has(normalized.key) || keys.has(normalized.key)) continue;
        keys.add(normalized.key);
        kept.push({ ...item, url: normalized.url });
      }
      if (kept.length === 0) {
        return this.skipInTransaction(id, "no-new-items", input);
      }
      const now = acceptedAt.toISOString();
      const insert = this.#db.prepare(
        "INSERT OR IGNORE INTO proactive_seen_urls (urlKey, url, runId, createdAt) VALUES (?, ?, ?, ?)",
      );
      for (const item of kept) {
        const normalized = normalizeProactiveUrl(item.url)!;
        insert.run(normalized.key, normalized.url, id, now);
      }
      this.#db.prepare(`UPDATE proactive_runs SET status = 'decided', decision = 'notify', reason = ?,
        itemsJson = ?, toolCalls = ?, tokens = ?, decidedAt = ?, quotaDate = ? WHERE id = ? AND status = 'running'`)
        .run(input.reason, JSON.stringify(kept), input.toolCalls, input.tokens, now, quotaDate, id);
      return this.get(id)!;
    });
  }

  acceptSkip(
    id: number,
    input: { readonly reason: string; readonly errorCode?: string; readonly toolCalls: number; readonly tokens: number },
  ): ProactiveRun {
    return this.transaction(() => this.skipInTransaction(id, input.reason, input));
  }

  private skipInTransaction(
    id: number,
    reason: string,
    progress: { readonly toolCalls: number; readonly tokens: number },
  ): ProactiveRun {
    const now = this.#now().toISOString();
    this.#db.prepare(`UPDATE proactive_runs SET status = 'skipped', decision = 'skip', reason = ?,
      toolCalls = ?, tokens = ?, decidedAt = ?, completedAt = ? WHERE id = ? AND status = 'running'`)
      .run(reason.slice(0, 500), progress.toolCalls, progress.tokens, now, now, id);
    return this.get(id)!;
  }

  /** `decided -> delivering` after the host enqueued the Inbox job. */
  markDelivering(id: number, requestId: string): ProactiveRun {
    const changed = this.#db.prepare(`UPDATE proactive_runs SET status = 'delivering', deliveryRequestId = ?,
      deliveryStatus = 'queued' WHERE id = ? AND status = 'decided'`).run(requestId, id);
    if (changed.changes !== 1) throw new Error("Proactive run is not decided");
    return this.get(id)!;
  }

  /** Terminal delivery state; only a delivering run can be reconciled. */
  reconcileDelivery(id: number, status: "delivered" | "delivery_failed" | "delivery_uncertain", error?: string): ProactiveRun | undefined {
    const now = this.#now().toISOString();
    this.#db.prepare(`UPDATE proactive_runs SET status = ?, deliveryStatus = ?, deliveryError = ?, completedAt = ?
      WHERE id = ? AND status = 'delivering'`)
      .run(status, status.replace("delivery_", ""), error?.slice(0, 200) ?? null, now, id);
    return this.get(id);
  }

  /** An operator decision after checking Telegram. Never called automatically. */
  resolveDelivery(id: number, outcome: "delivered" | "failed"): ProactiveRun {
    return this.transaction(() => {
      const current = this.get(id);
      if (current === undefined) throw new Error(`Proactive run ${id} was not found`);
      if (current.status !== "delivery_uncertain") throw new Error(`Proactive run ${id} is ${current.status}`);
      const now = this.#now().toISOString();
      const status = outcome === "delivered" ? "delivered" : "delivery_failed";
      this.#db.prepare(`UPDATE proactive_runs SET status = ?, deliveryStatus = ?, deliveryError = NULL, completedAt = ?
        WHERE id = ? AND status = 'delivery_uncertain'`).run(status, outcome, now, id);
      return this.get(id)!;
    });
  }

  /** A run failure never sends anything; an interrupted delivering run is not a run failure. */
  fail(id: number, code: string): ProactiveRun | undefined {
    const now = this.#now().toISOString();
    this.#db.prepare(`UPDATE proactive_runs SET status = 'failed', errorCode = ?, completedAt = ?
      WHERE id = ? AND status IN ('queued', 'running', 'decided')`).run(code.slice(0, 128), now, id);
    return this.get(id);
  }

  /**
   * Only a run with neither a conversation nor a Submission can safely return to the queue.
   * A stored conversation may already contain a submitted request whose ID was not attached
   * before a crash; the runner must recover that identity. Delivery states are only reconciled.
   */
  recover(): void {
    this.transaction(() => {
      this.#db.prepare(`UPDATE proactive_runs SET status = 'queued', startedAt = NULL, conversationId = NULL,
        toolCalls = 0, tokens = 0 WHERE status = 'running' AND conversationId IS NULL AND submissionId IS NULL`).run();
    });
  }

  /** Runs the runner must resume after a restart, in creation order. */
  unfinished(): ProactiveRun[] {
    return (this.#db.prepare(`SELECT r.*, t.triggerKey, t.kind FROM proactive_runs r
      JOIN proactive_triggers t ON t.id = r.triggerId
      WHERE r.status IN ('running', 'decided') ORDER BY r.id`).all() as unknown[]).map(row);
  }

  delivering(): ProactiveRun[] {
    return (this.#db.prepare(`SELECT r.*, t.triggerKey, t.kind FROM proactive_runs r
      JOIN proactive_triggers t ON t.id = r.triggerId
      WHERE r.status = 'delivering' ORDER BY r.id`).all() as unknown[]).map(row);
  }

  close(): void {
    this.#db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

export type ProactiveDeliveryState = "pending" | "ready" | "sending" | "sent" | "failed" | "uncertain" | "missing";

export type ProactiveSchedulerOptions = {
  readonly store: ProactiveStore;
  readonly config: ProactiveConfig;
  readonly runner: { run(runId: number, signal: AbortSignal): Promise<void> };
  readonly inbox: { deliveryStatus(requestId: string): ProactiveDeliveryState };
  /** Shutdown signal; an interrupted run keeps its durable Submission for the next start. */
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
};

/**
 * In-process proactive scheduler. It creates the once-daily trigger, claims at most one queued
 * run per pass, and reconciles delivery states. It never contains model or delivery business
 * logic; a failed pass is logged and the next pass continues.
 */
export class ProactiveScheduler {
  readonly #store: ProactiveStore;
  readonly #config: ProactiveConfig;
  readonly #runner: ProactiveSchedulerOptions["runner"];
  readonly #inbox: ProactiveSchedulerOptions["inbox"];
  readonly #signal?: AbortSignal;
  readonly #log: (line: string) => void;
  readonly #now: () => Date;
  readonly #stop = new AbortController();
  #loop: Promise<void> | undefined;
  #started = false;
  #busy = false;

  constructor(options: ProactiveSchedulerOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#runner = options.runner;
    this.#inbox = options.inbox;
    this.#signal = options.signal;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#now = options.now ?? (() => new Date());
  }

  private signal(): AbortSignal {
    return this.#signal === undefined ? this.#stop.signal : AbortSignal.any([this.#signal, this.#stop.signal]);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#loop = this.loop(this.signal()).catch((error: unknown) => {
      this.#log(`Proactive scheduler stopped (${error instanceof Error ? error.message : "unknown error"})`);
    });
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#loop?.catch(() => undefined);
    this.#started = false;
  }

  /** One deterministic pass, exposed for tests and operators. */
  async runDue(signal: AbortSignal = this.signal()): Promise<void> {
    this.reconcileDeliveries();
    this.enqueueDaily(this.#now());
    if (this.#busy || signal.aborted) return;
    const run = this.#store.claimNext();
    if (run === undefined) return;
    this.#busy = true;
    try {
      await this.#runner.run(run.id, signal);
    } catch (error) {
      // Shutdown keeps the durable Submission for the next start; it is not a run failure.
      if (signal.aborted) {
        this.#log(`Proactive run ${run.id} interrupted`);
        return;
      }
      const message = error instanceof Error ? error.message : "unknown error";
      this.#log(`Proactive run ${run.id} failed unexpectedly (${message})`);
      this.#store.fail(run.id, "PROACTIVE_RUN_ERROR");
    } finally {
      this.#busy = false;
    }
  }

  /** Daily trigger creation only; it never bypasses a delivery cap. */
  enqueueDaily(now: Date): void {
    const time = localTime(now, this.#config.timezone);
    if (time < this.#config.dailyAt) return;
    const date = localDate(now, this.#config.timezone);
    this.#store.enqueueTrigger({
      kind: "daily",
      triggerKey: `daily:${date}`,
      timezone: this.#config.timezone,
      localDate: date,
    });
  }

  /** Reconcile every queued Inbox delivery. An unknown result is never resent. */
  reconcileDeliveries(): void {
    for (const run of this.#store.delivering()) {
      if (run.deliveryRequestId === null) {
        this.#store.reconcileDelivery(run.id, "delivery_uncertain", "DELIVERY_REQUEST_MISSING");
        this.#deliverySpan(run, "delivery_uncertain", "DELIVERY_REQUEST_MISSING");
        continue;
      }
      const state = this.#inbox.deliveryStatus(run.deliveryRequestId);
      if (state === "sent") {
        this.#store.reconcileDelivery(run.id, "delivered");
        this.#deliverySpan(run, "delivered");
      } else if (state === "failed") {
        this.#store.reconcileDelivery(run.id, "delivery_failed", "DELIVERY_FAILED");
        this.#deliverySpan(run, "delivery_failed", "DELIVERY_FAILED");
      } else if (state === "uncertain" || state === "missing") {
        const code = `DELIVERY_${state.toUpperCase()}`;
        this.#store.reconcileDelivery(run.id, "delivery_uncertain", code);
        this.#deliverySpan(run, "delivery_uncertain", code);
      }
      // pending / ready / sending: still in flight; the next pass checks again.
    }
  }

  #deliverySpan(run: ProactiveRun, status: string, errorCode?: string): void {
    if (run.conversationId === null) return;
    const span = beginConversationTrace({
      conversationId: run.conversationId,
      name: "telegram.delivery",
      fields: { runId: run.id, requestId: run.deliveryRequestId ?? "", status, ...(errorCode === undefined ? {} : { errorCode }) },
    });
    span?.end(status === "delivered" ? "ok" : status === "delivery_uncertain" ? "unknown" : "error", {
      runId: run.id,
      status,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runDue(signal);
      } catch (error) {
        this.#log(`Proactive scheduler pass failed (${error instanceof Error ? error.message : "unknown error"})`);
      }
      if (signal.aborted) break;
      await this.sleep(IDLE_WAKE_MS, signal);
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
