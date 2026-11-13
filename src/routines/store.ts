import { DatabaseSync } from "node:sqlite";
import {
  NO_REPORT,
  ROUTINE_SCHEMA_SQL,
  type CreateRoutineInput,
  type RoutineDelivery,
  type RoutineMode,
  type RoutineRow,
  type RoutineSchedule,
  type RoutineStatus,
  type RoutineView,
  type RunRow,
  type RunStatus,
  type ScheduleRow,
} from "./protocol.js";
import { nextOccurrence } from "./schedule.js";

type RoutineDbRow = {
  id: number;
  chat_id: string;
  title: string;
  timezone: string;
  mode: string;
  brief: string | null;
  text: string | null;
  delivery: string;
  status: string;
  conversation_id: number | null;
  consecutive_failures: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  s_kind?: string;
  s_spec?: string;
  s_next_due_at?: string;
  s_last_run_at?: string | null;
};

type RunDbRow = {
  id: number;
  routine_id: number;
  run_key: string;
  trigger_kind: string;
  status: string;
  scheduled_for: string | null;
  not_before: string | null;
  started_at: string | null;
  finished_at: string | null;
  reply: string | null;
  error_code: string | null;
  attempts: number;
  lease_until: string | null;
  created_at: string;
};

export type Usage = {
  readonly agentRuns: number;
  readonly agentFailures: number;
  readonly notifyRuns: number;
  readonly top: readonly { readonly id: number; readonly title: string; readonly runs: number }[];
};

function routine(row: RoutineDbRow): RoutineRow {
  return {
    id: row.id,
    chatId: row.chat_id,
    title: row.title,
    timezone: row.timezone,
    mode: row.mode as RoutineMode,
    brief: row.brief,
    text: row.text,
    delivery: row.delivery as RoutineDelivery,
    status: row.status as RoutineStatus,
    conversationId: row.conversation_id,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function schedule(row: RoutineDbRow): ScheduleRow {
  return {
    routineId: row.id,
    kind: (row.s_kind ?? "daily") as ScheduleRow["kind"],
    spec: JSON.parse(row.s_spec ?? "{\"kind\":\"daily\",\"at\":\"08:00\"}") as RoutineSchedule,
    nextDueAt: row.s_next_due_at ?? row.updated_at,
    lastRunAt: row.s_last_run_at ?? null,
  };
}

function run(row: RunDbRow): RunRow {
  return {
    id: row.id,
    routineId: row.routine_id,
    runKey: row.run_key,
    trigger: row.trigger_kind as RunRow["trigger"],
    status: row.status as RunStatus,
    scheduledFor: row.scheduled_for,
    notBefore: row.not_before,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    reply: row.reply,
    errorCode: row.error_code,
    attempts: row.attempts,
    leaseUntil: row.lease_until,
    createdAt: row.created_at,
  };
}

/**
 * The routine ledger. It stores what the host decided and what happened; no message text beyond the
 * final reply, so the file stays auditable without duplicating the agent's transcript.
 */
export class SqliteRoutineStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #listeners = new Set<() => void>();

  constructor(path: string, options: { readonly now?: () => Date } = {}) {
    this.#db = new DatabaseSync(path);
    this.#now = options.now ?? (() => new Date());
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    for (const statement of ROUTINE_SCHEMA_SQL) this.#db.exec(statement);
  }

  create(input: CreateRoutineInput): RoutineView {
    const created = this.transaction(() => {
      const stamp = input.now.toISOString();
      const inserted = this.#db.prepare(`INSERT INTO routines
        (chat_id, title, timezone, mode, brief, text, delivery, status, conversation_id,
         consecutive_failures, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, 0, NULL, ?, ?)`).run(
        input.chatId,
        input.title,
        input.timezone,
        input.mode,
        input.brief ?? null,
        input.text ?? null,
        input.delivery,
        stamp,
        stamp,
      );
      const id = Number(inserted.lastInsertRowid);
      const next = nextOccurrence(input.schedule, input.now, input.timezone).toISOString();
      this.#db.prepare(`INSERT INTO routine_schedules (routine_id, kind, spec, next_due_at, last_run_at)
        VALUES (?, ?, ?, ?, NULL)`).run(id, input.schedule.kind, JSON.stringify(input.schedule), next);
      return id;
    });
    this.wake();
    const view = this.get(created);
    if (view === undefined) throw new Error("Routine disappeared after insert");
    return view;
  }

  get(id: number): RoutineView | undefined {
    const row = this.#db.prepare(`SELECT r.*, s.kind AS s_kind, s.spec AS s_spec,
      s.next_due_at AS s_next_due_at, s.last_run_at AS s_last_run_at
      FROM routines r JOIN routine_schedules s ON s.routine_id = r.id WHERE r.id = ?`).get(id) as RoutineDbRow | undefined;
    if (row === undefined) return undefined;
    return { ...routine(row), schedule: schedule(row) };
  }

  list(chatId: string): readonly RoutineView[] {
    const rows = this.#db.prepare(`SELECT r.*, s.kind AS s_kind, s.spec AS s_spec,
      s.next_due_at AS s_next_due_at, s.last_run_at AS s_last_run_at
      FROM routines r JOIN routine_schedules s ON s.routine_id = r.id
      WHERE r.chat_id = ? AND r.status != 'stopped' ORDER BY r.id`).all(chatId) as RoutineDbRow[];
    return rows.map((row) => ({ ...routine(row), schedule: schedule(row) }));
  }

  countActive(chatId: string): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM routines WHERE chat_id = ? AND status != 'stopped'").get(chatId) as { n: number };
    return Number(row.n);
  }

  setStatus(id: number, status: RoutineStatus): RoutineView {
    this.#db.prepare("UPDATE routines SET status = ?, updated_at = ? WHERE id = ?").run(status, this.now().toISOString(), id);
    this.wake();
    const view = this.get(id);
    if (view === undefined) throw new Error("Routine not found");
    return view;
  }

  /** The chat-level kill switch: pause or resume every routine the owner can see. */
  setStatusAll(chatId: string, from: readonly RoutineStatus[], to: RoutineStatus): number {
    const stamp = this.now().toISOString();
    let changed = 0;
    this.transaction(() => {
      const statement = this.#db.prepare("UPDATE routines SET status = ?, updated_at = ? WHERE chat_id = ? AND status = ?");
      for (const status of from) changed += Number(statement.run(to, stamp, chatId, status).changes);
    });
    this.wake();
    return changed;
  }

  delete(id: number): boolean {
    const changed = Number(this.#db.prepare("DELETE FROM routines WHERE id = ?").run(id).changes);
    this.wake();
    return changed === 1;
  }

  setConversation(id: number, conversationId: number): void {
    this.#db.prepare("UPDATE routines SET conversation_id = ?, updated_at = ? WHERE id = ?")
      .run(conversationId, this.now().toISOString(), id);
  }

  /**
   * Moves every active schedule that is due into the run ledger.
   *
   * The schedule is advanced first, inside the same transaction, so a crash after this point loses
   * no slot and a restart cannot run it twice. A slot missed by more than `graceHours` becomes a
   * `skipped` row instead of a run: five days of downtime must not replay five breakfasts.
   */
  claimDue(now: Date, graceHours: number, limit = 20): readonly { readonly run: RunRow; readonly routine: RoutineRow }[] {
    const nowIso = now.toISOString();
    const due = this.#db.prepare(`SELECT r.*, s.kind AS s_kind, s.spec AS s_spec,
      s.next_due_at AS s_next_due_at, s.last_run_at AS s_last_run_at
      FROM routines r JOIN routine_schedules s ON s.routine_id = r.id
      WHERE r.status = 'active' AND s.next_due_at <= ?
      ORDER BY s.next_due_at LIMIT ?`).all(nowIso, limit) as RoutineDbRow[];
    if (due.length === 0) return [];
    const claimed: { run: RunRow; routine: RoutineRow }[] = [];
    this.transaction(() => {
      for (const row of due) {
        const spec = JSON.parse(row.s_spec ?? "{}") as RoutineSchedule;
        const dueAt = row.s_next_due_at ?? nowIso;
        const next = nextOccurrence(spec, now, row.timezone).toISOString();
        this.#db.prepare("UPDATE routine_schedules SET next_due_at = ?, last_run_at = ? WHERE routine_id = ?")
          .run(next, dueAt, row.id);
        const missedMs = now.getTime() - Date.parse(dueAt);
        const late = missedMs > graceHours * 3_600_000;
        const inserted = this.#db.prepare(`INSERT OR IGNORE INTO routine_runs
          (routine_id, run_key, trigger_kind, status, scheduled_for, not_before, started_at, finished_at,
           reply, error_code, attempts, lease_until, created_at)
          VALUES (?, ?, 'schedule', ?, ?, NULL, NULL, ?, NULL, ?, 0, NULL, ?)`).run(
          row.id,
          `sched:${dueAt}`,
          late ? "skipped" : "queued",
          dueAt,
          late ? nowIso : null,
          late ? "MISSED_WINDOW" : null,
          nowIso,
        );
        if (Number(inserted.changes) === 1 && !late) {
          const created = this.#db.prepare("SELECT * FROM routine_runs WHERE id = ?").get(Number(inserted.lastInsertRowid)) as RunDbRow;
          claimed.push({ run: run(created), routine: routine(row) });
        }
      }
    });
    return claimed;
  }

  /** The oldest claimable run becomes this process's; a second caller gets nothing. */
  claimRun(now: Date, leaseMs: number): RunRow | undefined {
    const nowIso = now.toISOString();
    const id = this.transaction(() => {
      const row = this.#db.prepare(`SELECT * FROM routine_runs
        WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?)
        ORDER BY id LIMIT 1`).get(nowIso) as RunDbRow | undefined;
      if (row === undefined) return undefined;
      const changed = this.#db.prepare(`UPDATE routine_runs SET status = 'running', started_at = ?,
        attempts = attempts + 1, lease_until = ? WHERE id = ? AND status = 'queued'`)
        .run(nowIso, new Date(now.getTime() + leaseMs).toISOString(), row.id);
      return Number(changed.changes) === 1 ? row.id : undefined;
    });
    if (id === undefined) return undefined;
    return run(this.#db.prepare("SELECT * FROM routine_runs WHERE id = ?").get(id) as RunDbRow);
  }

  finish(runId: number, status: RunStatus, fields: { readonly reply?: string; readonly errorCode?: string } = {}): void {
    this.#db.prepare(`UPDATE routine_runs SET status = ?, finished_at = ?, reply = ?, error_code = ?, lease_until = NULL
      WHERE id = ?`).run(
      status,
      this.now().toISOString(),
      fields.reply === undefined ? null : fields.reply.slice(0, 8_000),
      fields.errorCode === undefined ? null : fields.errorCode.slice(0, 128),
      runId,
    );
  }

  /** Puts the same run back in the queue after a recoverable failure. */
  retry(runId: number, notBefore: Date): void {
    this.#db.prepare(`UPDATE routine_runs SET status = 'queued', not_before = ?, started_at = NULL,
      finished_at = NULL, lease_until = NULL, error_code = NULL WHERE id = ?`)
      .run(notBefore.toISOString(), runId);
    this.wake();
  }

  markSuccess(routineId: number): void {
    this.#db.prepare("UPDATE routines SET consecutive_failures = 0, last_error = NULL, updated_at = ? WHERE id = ?")
      .run(this.now().toISOString(), routineId);
  }

  markFailure(routineId: number, code: string): number {
    this.#db.prepare("UPDATE routines SET consecutive_failures = consecutive_failures + 1, last_error = ?, updated_at = ? WHERE id = ?")
      .run(code.slice(0, 128), this.now().toISOString(), routineId);
    const row = this.#db.prepare("SELECT consecutive_failures FROM routines WHERE id = ?").get(routineId) as { consecutive_failures: number } | undefined;
    return row === undefined ? 0 : Number(row.consecutive_failures);
  }

  /** Startup: a run left `running` belongs to a dead process. It is failed, never replayed. */
  recover(): number {
    const nowIso = this.now().toISOString();
    let recovered = 0;
    this.transaction(() => {
      const rows = this.#db.prepare("SELECT id, routine_id FROM routine_runs WHERE status = 'running'").all() as { id: number; routine_id: number }[];
      for (const row of rows) {
        this.#db.prepare(`UPDATE routine_runs SET status = 'failed', finished_at = ?, error_code = 'PROCESS_INTERRUPTED',
          lease_until = NULL WHERE id = ?`).run(nowIso, row.id);
        this.#db.prepare("UPDATE routines SET consecutive_failures = consecutive_failures + 1, last_error = 'PROCESS_INTERRUPTED' WHERE id = ?")
          .run(row.routine_id);
        recovered += 1;
      }
    });
    return recovered;
  }

  nextDueAt(): string | undefined {
    const row = this.#db.prepare(`SELECT MIN(s.next_due_at) AS due FROM routine_schedules s
      JOIN routines r ON r.id = s.routine_id WHERE r.status = 'active'`).get() as { due: string | null };
    return row.due ?? undefined;
  }

  enqueueManual(routineId: number, now: Date): RunRow {
    const key = `manual:${now.getTime()}:${Math.random().toString(36).slice(2, 8)}`;
    const inserted = this.#db.prepare(`INSERT INTO routine_runs
      (routine_id, run_key, trigger_kind, status, scheduled_for, not_before, started_at, finished_at,
       reply, error_code, attempts, lease_until, created_at)
      VALUES (?, ?, 'manual', 'queued', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?)`)
      .run(routineId, key, now.toISOString());
    this.wake();
    return run(this.#db.prepare("SELECT * FROM routine_runs WHERE id = ?").get(Number(inserted.lastInsertRowid)) as RunDbRow);
  }

  usage(fromIso: string, toIso: string): Usage {
    const totals = this.#db.prepare(`SELECT
        SUM(CASE WHEN t.mode = 'agent' AND r.status IN ('succeeded','failed') THEN 1 ELSE 0 END) AS agent_runs,
        SUM(CASE WHEN t.mode = 'agent' AND r.status = 'failed' THEN 1 ELSE 0 END) AS agent_failures,
        SUM(CASE WHEN t.mode = 'notify' AND r.status IN ('succeeded','failed') THEN 1 ELSE 0 END) AS notify_runs
      FROM routine_runs r JOIN routines t ON t.id = r.routine_id
      WHERE r.finished_at >= ? AND r.finished_at < ?`).get(fromIso, toIso) as
      { agent_runs: number | null; agent_failures: number | null; notify_runs: number | null };
    const top = this.#db.prepare(`SELECT t.id, t.title, COUNT(*) AS runs
      FROM routine_runs r JOIN routines t ON t.id = r.routine_id
      WHERE t.mode = 'agent' AND r.status IN ('succeeded','failed')
        AND r.finished_at >= ? AND r.finished_at < ?
      GROUP BY t.id ORDER BY runs DESC, t.id LIMIT 3`).all(fromIso, toIso) as { id: number; title: string; runs: number }[];
    return {
      agentRuns: Number(totals.agent_runs ?? 0),
      agentFailures: Number(totals.agent_failures ?? 0),
      notifyRuns: Number(totals.notify_runs ?? 0),
      top: top.map((row) => ({ id: row.id, title: row.title, runs: Number(row.runs) })),
    };
  }

  meta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM routine_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT INTO routine_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  runs(routineId: number, limit = 20): readonly RunRow[] {
    const rows = this.#db.prepare("SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?")
      .all(routineId, limit) as RunDbRow[];
    return rows.map(run);
  }

  lastRun(routineId: number): RunRow | undefined {
    const row = this.#db.prepare("SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT 1")
      .get(routineId) as RunDbRow | undefined;
    return row === undefined ? undefined : run(row);
  }

  pendingRuns(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM routine_runs WHERE status IN ('queued','running')").get() as { n: number };
    return Number(row.n);
  }

  /** Old run rows are evidence, not state: a retention window keeps the daily counters cheap. */
  prune(cutoffIso: string): number {
    return Number(this.#db.prepare("DELETE FROM routine_runs WHERE finished_at IS NOT NULL AND finished_at < ?")
      .run(cutoffIso).changes);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  wake(): void {
    for (const listener of this.#listeners) listener();
  }

  close(): void {
    this.#db.close();
  }

  private now(): Date {
    return this.#now();
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

/** Exported for the runtime and tests: the sentinel is part of the contract, not a magic string. */
export function isNoReport(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === NO_REPORT || trimmed === `[${NO_REPORT}]`;
}
