/**
 * The seam between the polling half and the push half of the watchers feature.
 *
 * Both halves produce the same thing — a deterministic event key plus one line of text — and the
 * store is the only place that decides whether that key is new. Keeping the seam this small is what
 * lets the delivery path stay identical whether an event arrived by webhook or by polling.
 */

export type WatchKind = "github_run" | "github_pr" | "github_events" | "feed" | "x";

/** `push` sources are never polled; they are reconciled. `poll` sources are driven by nextCheckAt. */
export type SourceMode = "push" | "poll";

export type SourceStatus = "active" | "backoff" | "error" | "paused" | "stopped";

export const WATCH_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS watchers (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     chat_id TEXT NOT NULL,
     thread_ts TEXT,
     kind TEXT NOT NULL,
     target TEXT NOT NULL,
     label TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'active',
     max_events_per_hour INTEGER NOT NULL DEFAULT 10,
     created_at TEXT NOT NULL,
     stopped_at TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS watchers_live
     ON watchers(chat_id, kind, target) WHERE status IN ('active', 'paused')`,
  `CREATE TABLE IF NOT EXISTS sources (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     watcher_id INTEGER NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     location TEXT NOT NULL,
     mode TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'active',
     interval_sec INTEGER NOT NULL,
     next_check_at TEXT,
     reconcile_at TEXT,
     etag TEXT,
     last_modified TEXT,
     cursor TEXT,
     failures INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     last_check_at TEXT,
     UNIQUE(watcher_id)
   )`,
  `CREATE INDEX IF NOT EXISTS sources_due ON sources(status, next_check_at)`,
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
     dedup_key TEXT NOT NULL,
     delivery_id TEXT,
     kind TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     received_at TEXT NOT NULL,
     facts TEXT NOT NULL,
     UNIQUE(source_id, dedup_key)
   )`,
  `CREATE TABLE IF NOT EXISTS outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     watcher_id INTEGER NOT NULL,
     event_id INTEGER NOT NULL UNIQUE,
     chat_id TEXT NOT NULL,
     thread_ts TEXT,
     text TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     attempts INTEGER NOT NULL DEFAULT 0,
     message_id TEXT,
     created_at TEXT NOT NULL,
     sent_at TEXT,
     failure_code TEXT
   )`,
];

export type WatcherRow = {
  readonly id: number;
  readonly chatId: string;
  readonly threadTs: string | null;
  readonly kind: WatchKind;
  readonly target: string;
  readonly label: string;
  readonly status: string;
  readonly maxEventsPerHour: number;
  readonly createdAt: string;
  readonly stoppedAt: string | null;
};

export type SourceRow = {
  readonly id: number;
  readonly watcherId: number;
  readonly kind: WatchKind;
  readonly location: string;
  readonly mode: SourceMode;
  readonly status: SourceStatus;
  readonly intervalSec: number;
  readonly nextCheckAt: string | null;
  readonly reconcileAt: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly cursor: string | null;
  readonly failures: number;
  readonly lastError: string | null;
  readonly lastCheckAt: string | null;
};

/** One thing that happened. `dedupKey` is semantic (a terminal state), never a delivery id. */
export type WatchEventInput = {
  readonly dedupKey: string;
  readonly deliveryId?: string;
  readonly kind: string;
  readonly occurredAt: string;
  /** Structured facts only: identifiers, states, links. Never a body of text to be trusted. */
  readonly facts: Readonly<Record<string, string | number | boolean>>;
  /** One deterministic line the host composed; the model may later rewrite it, never the reverse. */
  readonly text: string;
};

export type SourceState = {
  readonly etag?: string;
  readonly lastModified?: string;
  readonly cursor?: string;
};

export type SourceCheckResult = {
  readonly events: readonly WatchEventInput[];
  readonly state?: SourceState;
};

export type OutboxRow = {
  readonly id: number;
  readonly watcherId: number;
  readonly eventId: number;
  readonly chatId: string;
  readonly threadTs: string | null;
  readonly text: string;
  readonly status: "pending" | "sending" | "sent" | "failed" | "uncertain";
  readonly attempts: number;
  readonly createdAt: string;
};

export type CreateWatcherInput = {
  readonly chatId: string;
  readonly threadTs?: string;
  readonly kind: WatchKind;
  readonly target: string;
  readonly label: string;
  readonly location: string;
  readonly mode: SourceMode;
  readonly intervalSec: number;
  readonly now: string;
};

export interface WatchStore {
  /** Creates the watcher and its single source row. A live duplicate target is a refusal, not an insert. */
  create(input: CreateWatcherInput): { readonly watcherId: number; readonly sourceId: number };
  list(chatId: string): readonly (WatcherRow & { readonly source: SourceRow })[];
  /** Stops the watcher and its source; returns false when it was already stopped. */
  stop(chatId: string, watcherId: number, now: string): boolean;
  /** Claims due poll sources by moving nextCheckAt forward. Empty array means nothing is due. */
  claimDue(now: string, limit: number, leaseSeconds: number): readonly SourceRow[];
  /** Applies a successful check: inserts new events (dropping duplicates) and returns how many were new. */
  finish(sourceId: number, result: SourceCheckResult, now: string, nextCheckAt: string): number;
  /** Applies a failed check: counters, reason code and the next attempt time. */
  fail(sourceId: number, code: string, now: string, nextCheckAt: string): void;
  /** Inserts one event (false when its key already exists) and queues its message in the same transaction. */
  ingest(sourceId: number, event: WatchEventInput, now: string): boolean;
  pending(limit: number): readonly OutboxRow[];
  /** pending -> sending, so a crash between these two states is visible on the next start. */
  claimOutbox(id: number): boolean;
  sent(id: number, messageId: string, now: string): void;
  failed(id: number, code: string, now: string, uncertain: boolean): void;
  /** Startup: rows left in `sending` become `uncertain`; returns how many were recovered. */
  recoverInterrupted(now: string): number;
  /** Sources whose reconcileAt is due; push sources use this, poll sources ignore it. */
  dueReconcile(now: string, limit: number): readonly SourceRow[];
}

/** One source adapter. It fetches, compares and reports; it never decides what the user sees. */
export interface SourceCheck {
  check(source: SourceRow, signal: AbortSignal): Promise<SourceCheckResult>;
}

export const WATCH_REASON_CODES = [
  "WATCH_TARGET_INVALID",
  "WATCH_LIMIT_EXCEEDED",
  "WATCH_DUPLICATE",
  "WATCH_SOURCE_GONE",
  "WATCH_SOURCE_AUTH",
  "WATCH_RATE_LIMITED",
  "WATCH_FETCH_TIMEOUT",
  "WATCH_PARSE_FAILED",
  "WATCH_FEED_TOO_LARGE",
  "WATCH_DELIVERY_FAILED",
  "WATCH_DELIVERY_UNCERTAIN",
  "WATCH_STORE_ERROR",
  "TRIGGER_SIG_MISMATCH",
  "TRIGGER_CURSOR_GAP",
  "TRIGGER_RELAY_DOWN",
  "TRIGGER_PAYLOAD_INVALID",
  "PROCESS_INTERRUPTED",
] as const;

export type WatchReasonCode = (typeof WATCH_REASON_CODES)[number];

/** Resolved once at startup by the integration layer; adapters receive it, they never read env. */
export type WatchersConfig = {
  readonly enabled: boolean;
  readonly maxActive: number;
  readonly maxPerHour: number;
  readonly feedIntervalSec: number;
  readonly xIntervalSec: number;
  readonly githubReconcileMin: number;
  readonly fetchTimeoutMs: number;
  readonly relayUrl?: string;
  readonly relayToken?: string;
  readonly githubToken?: string;
};
