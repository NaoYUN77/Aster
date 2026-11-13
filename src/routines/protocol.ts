/**
 * Standing tasks ("routines"): a host-owned schedule that makes the agent act without a chat
 * message. The name avoids the engine's own `Task`: a routine is a *business object* with a
 * trigger, a run and a delivery, while a durable task is one recoverable unit of execution.
 *
 * Only schedules are in scope here. Event triggers arrive in the second batch and bind a routine to
 * a watcher source; the run and delivery halves are identical, which is why the table already
 * carries a trigger kind instead of assuming a clock.
 */

export type RoutineMode = "notify" | "agent";
/** `always` sends every run; `report` suppresses a run whose answer is `NO_REPORT`. */
export type RoutineDelivery = "always" | "report";
export type RoutineStatus = "active" | "paused" | "stopped";
export type ScheduleKind = "daily" | "weekly" | "every";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "suppressed" | "skipped";
export type RunTrigger = "schedule" | "manual";

/** The sentinel an agent run returns when a report-only task has nothing to say. */
export const NO_REPORT = "NO_REPORT";

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type RoutineSchedule =
  | { readonly kind: "daily"; readonly at: string }
  | { readonly kind: "weekly"; readonly days: readonly number[]; readonly at: string }
  | { readonly kind: "every"; readonly minutes: number; readonly from?: string; readonly to?: string };

export const ROUTINE_DEFAULTS = {
  timezone: "Asia/Shanghai",
  maxPerOwner: 50,
  /** A floor that stops a typo from turning into a model call every minute. */
  minIntervalMinutes: 5,
  /** 0 means no hard cap; the daily summary and anomaly alert are the backstop. */
  maxRunsPerDay: 0,
  runTimeoutMs: 600_000,
  summaryLocalTime: "21:00",
  retentionDays: 90,
  /** A slot missed by more than this is skipped instead of replayed. */
  catchUpGraceHours: 6,
  maxAttempts: 2,
  retryDelaySec: 120,
  consecutiveFailureAlert: 3,
} as const;

export type RoutinesConfig = {
  readonly enabled: boolean;
  /** ROUTINES_PAUSED=1 is the process-level kill switch: no run is dispatched. */
  readonly paused: boolean;
  readonly timezone: string;
  readonly maxPerOwner: number;
  readonly minIntervalMinutes: number;
  /** 0 disables the hard cap (the confirmed default). */
  readonly maxRunsPerDay: number;
  readonly runTimeoutMs: number;
  readonly summaryEnabled: boolean;
  readonly summaryLocalTime: string;
  readonly retentionDays: number;
};

export class RoutineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RoutineError";
  }
}

export const ROUTINE_REASON_CODES = [
  "ROUTINE_INVALID_TITLE",
  "ROUTINE_INVALID_TIMEZONE",
  "ROUTINE_INVALID_TIME",
  "ROUTINE_INVALID_SCHEDULE",
  "ROUTINE_INVALID_INTERVAL",
  "ROUTINE_MISSING_BRIEF",
  "ROUTINE_MISSING_TEXT",
  "ROUTINE_LIMIT_EXCEEDED",
  "ROUTINE_NOT_FOUND",
  "ROUTINE_PAUSED",
  "ROUTINE_STORE_ERROR",
  "PROCESS_INTERRUPTED",
] as const;

export type RoutineReasonCode = (typeof ROUTINE_REASON_CODES)[number];

export type RoutineRow = {
  readonly id: number;
  readonly chatId: string;
  readonly title: string;
  readonly timezone: string;
  readonly mode: RoutineMode;
  readonly brief: string | null;
  readonly text: string | null;
  readonly delivery: RoutineDelivery;
  readonly status: RoutineStatus;
  readonly conversationId: number | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ScheduleRow = {
  readonly routineId: number;
  readonly kind: ScheduleKind;
  readonly spec: RoutineSchedule;
  readonly nextDueAt: string;
  readonly lastRunAt: string | null;
};

export type RoutineView = RoutineRow & { readonly schedule: ScheduleRow };

export type RunRow = {
  readonly id: number;
  readonly routineId: number;
  readonly runKey: string;
  readonly trigger: RunTrigger;
  readonly status: RunStatus;
  readonly scheduledFor: string | null;
  /** Retry backoff and event coalescing land here; a queued run is only claimable after it. */
  readonly notBefore: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly reply: string | null;
  readonly errorCode: string | null;
  readonly attempts: number;
  readonly leaseUntil: string | null;
  readonly createdAt: string;
};

export type CreateRoutineInput = {
  readonly chatId: string;
  readonly title: string;
  readonly timezone: string;
  readonly mode: RoutineMode;
  readonly brief?: string;
  readonly text?: string;
  readonly delivery: RoutineDelivery;
  readonly schedule: RoutineSchedule;
  readonly now: Date;
};

export type RoutineTickResult = {
  readonly claimed: number;
  readonly ran: number;
  readonly delivered: number;
  readonly failed: number;
};

/** What the scheduler hands the agent for one run. */
export type RoutineRunRequest = {
  readonly routineId: number;
  readonly title: string;
  readonly brief: string;
  readonly timezone: string;
  readonly delivery: RoutineDelivery;
  readonly conversationId: number | undefined;
  readonly text: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
};

export type RoutineRunner = (request: RoutineRunRequest) => Promise<{ conversationId: number; text: string }>;

/**
 * One SQLite file, one writer. `routine_runs` is the durable ledger: the unique (routine, run key)
 * pair is what makes a restart, a replay or a double tick harmless.
 */
export const ROUTINE_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS routines (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     chat_id TEXT NOT NULL,
     title TEXT NOT NULL,
     timezone TEXT NOT NULL,
     mode TEXT NOT NULL,
     brief TEXT,
     text TEXT,
     delivery TEXT NOT NULL DEFAULT 'always',
     status TEXT NOT NULL DEFAULT 'active',
     conversation_id INTEGER,
     consecutive_failures INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS routines_chat ON routines(chat_id, status)`,
  `CREATE TABLE IF NOT EXISTS routine_schedules (
     routine_id INTEGER PRIMARY KEY REFERENCES routines(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     spec TEXT NOT NULL,
     next_due_at TEXT NOT NULL,
     last_run_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS routine_schedules_due ON routine_schedules(next_due_at)`,
  `CREATE TABLE IF NOT EXISTS routine_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
     run_key TEXT NOT NULL,
     trigger_kind TEXT NOT NULL,
     status TEXT NOT NULL,
     scheduled_for TEXT,
     not_before TEXT,
     started_at TEXT,
     finished_at TEXT,
     reply TEXT,
     error_code TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     lease_until TEXT,
     created_at TEXT NOT NULL,
     UNIQUE(routine_id, run_key)
   )`,
  `CREATE INDEX IF NOT EXISTS routine_runs_queue ON routine_runs(status, not_before, id)`,
  `CREATE TABLE IF NOT EXISTS routine_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];
