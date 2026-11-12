import { DatabaseSync } from "node:sqlite";
import {
  WATCH_SCHEMA_SQL,
  type CreateWatcherInput,
  type OutboxRow,
  type SourceCheckResult,
  type SourceMode,
  type SourceRow,
  type SourceStatus,
  type WatchEventInput,
  type WatchKind,
  type WatcherRow,
  type WatchReasonCode,
  type WatchStore,
} from "./protocol.js";

/**
 * Durable state for event tracking. Two things drive the design:
 *
 * 1. SQLite is the only source of truth. A watcher is created and stopped here, an event is deduped
 *    here, and an outbox row is claimed here — the network never decides whether something is new.
 * 2. Dedupe uses the event key alone (`UNIQUE(source_id, dedup_key)`), so a webhook redelivery and a
 *    reconcile pass that observe the same terminal state still produce exactly one message.
 *
 * The first successful check of a source is a baseline: it records the keys it saw as future dedupe
 * markers but queues nothing, which is what stops a new watcher from replaying history to the user.
 * Every write is one `BEGIN IMMEDIATE` transaction on a single connection, so one process owns the
 * file and a crash can leave at most `sending` (recovered as `uncertain`), never a duplicate send.
 */

/** A host-written failure. `code` is a fixed reason code, safe to log; the message is operator-facing. */
export class WatcherError extends Error {
  constructor(readonly code: WatchReasonCode, message: string) {
    super(message);
    this.name = "WatcherError";
  }
}

export type WatcherStoreOptions = {
  /** Operator CLI mode: no schema changes and no pragmas that write to the file. */
  readonly readOnly?: boolean;
  /** Refuse `create` beyond this many live (active/paused) watchers for the chat. Defaults to no bound. */
  readonly maxActive?: number;
  /** Per-watcher hourly message ceiling stored with the row. Defaults to 10. */
  readonly maxEventsPerHour?: number;
};

const LIVE_STATUSES = "('active', 'paused')";
const POLLABLE_STATUSES = "('active', 'backoff', 'error')";
const OUTBOX_TEXT_MAX_CHARS = 4_000;

type Row = Record<string, unknown>;

function watcher(record: Row): WatcherRow {
  return Object.freeze({
    id: Number(record.w_id ?? record.id),
    chatId: String(record.chat_id),
    threadTs: record.thread_ts === null ? null : String(record.thread_ts),
    kind: String(record.kind) as WatchKind,
    target: String(record.target),
    label: String(record.label),
    status: String(record.status),
    maxEventsPerHour: Number(record.max_events_per_hour),
    createdAt: String(record.created_at),
    stoppedAt: record.stopped_at === null ? null : String(record.stopped_at),
  });
}

function source(record: Row): SourceRow {
  return Object.freeze({
    id: Number(record.s_id ?? record.id),
    watcherId: Number(record.watcher_id),
    kind: String(record.kind) as WatchKind,
    location: String(record.location),
    mode: String(record.mode) as SourceRow["mode"],
    status: String(record.status) as SourceStatus,
    intervalSec: Number(record.interval_sec),
    nextCheckAt: record.next_check_at === null ? null : String(record.next_check_at),
    reconcileAt: record.reconcile_at === null ? null : String(record.reconcile_at),
    etag: record.etag === null ? null : String(record.etag),
    lastModified: record.last_modified === null ? null : String(record.last_modified),
    cursor: record.cursor === null ? null : String(record.cursor),
    failures: Number(record.failures),
    lastError: record.last_error === null ? null : String(record.last_error),
    lastCheckAt: record.last_check_at === null ? null : String(record.last_check_at),
  });
}

function outbox(record: Row): OutboxRow {
  return Object.freeze({
    id: Number(record.id),
    watcherId: Number(record.watcher_id),
    eventId: Number(record.event_id),
    chatId: String(record.chat_id),
    threadTs: record.thread_ts === null ? null : String(record.thread_ts),
    text: String(record.text),
    status: String(record.status) as OutboxRow["status"],
    attempts: Number(record.attempts),
    createdAt: String(record.created_at),
  });
}

function iso(value: Date): string {
  return value.toISOString();
}

export class WatcherStore implements WatchStore {
  readonly #db: DatabaseSync;
  readonly #maxActive: number;
  readonly #maxEventsPerHour: number;

  constructor(path: string, options: WatcherStoreOptions = {}) {
    this.#db = options.readOnly === true ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
    this.#maxActive = options.maxActive ?? Number.MAX_SAFE_INTEGER;
    this.#maxEventsPerHour = Math.max(1, Math.trunc(options.maxEventsPerHour ?? 10));
    this.#db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    if (options.readOnly !== true) {
      // WAL keeps each short write from blocking the operator CLI's read; the schema statements are all
      // `IF NOT EXISTS`, so running them on every start is the migration for this feature.
      this.#db.exec("PRAGMA journal_mode = WAL;");
      for (const statement of WATCH_SCHEMA_SQL) this.#db.exec(statement);
      this.#db.exec("PRAGMA user_version = 1");
    }
  }

  /**
   * Creates the watcher and its one source. A live duplicate is refused before the insert so the
   * caller gets a stable reason code instead of a bare SQLite uniqueness error; the partial unique
   * index stays as the last line of defence.
   */
  create(input: CreateWatcherInput): { readonly watcherId: number; readonly sourceId: number } {
    return this.#transaction(() => {
      const duplicate = this.#db.prepare(
        `SELECT id FROM watchers WHERE chat_id = ? AND kind = ? AND target = ? AND status IN ${LIVE_STATUSES}`,
      ).get(input.chatId, input.kind, input.target);
      if (duplicate !== undefined) {
        throw new WatcherError("WATCH_DUPLICATE", `a live watcher for ${input.kind} ${input.target} already exists`);
      }
      const live = Number((this.#db.prepare(
        `SELECT COUNT(*) AS n FROM watchers WHERE chat_id = ? AND status IN ${LIVE_STATUSES}`,
      ).get(input.chatId) as { n: number }).n);
      if (live >= this.#maxActive) {
        throw new WatcherError("WATCH_LIMIT_EXCEEDED", `at most ${this.#maxActive} active watchers are allowed`);
      }
      const insertedWatcher = this.#db.prepare(`INSERT INTO watchers
        (chat_id, thread_ts, kind, target, label, status, max_events_per_hour, created_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).run(
        input.chatId,
        input.threadTs ?? null,
        input.kind,
        input.target,
        input.label,
        this.#maxEventsPerHour,
        input.now,
      );
      const watcherId = Number(insertedWatcher.lastInsertRowid);
      // A poll source is due immediately: the first pass only records a baseline. A push source has
      // no scheduled check at all; reconcileAt is what makes it eligible for the reconcile pass.
      const insertedSource = this.#db.prepare(`INSERT INTO sources
        (watcher_id, kind, location, mode, status, interval_sec, next_check_at, reconcile_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`).run(
        watcherId,
        input.kind,
        input.location,
        input.mode,
        Math.max(1, Math.trunc(input.intervalSec)),
        input.mode === "poll" ? input.now : null,
        input.mode === "push" ? input.now : null,
      );
      return { watcherId, sourceId: Number(insertedSource.lastInsertRowid) };
    });
  }

  list(chatId: string): readonly (WatcherRow & { readonly source: SourceRow })[] {
    const rows = this.#db.prepare(`SELECT
        w.id AS w_id, w.chat_id, w.thread_ts, w.kind, w.target, w.label, w.status,
        w.max_events_per_hour, w.created_at, w.stopped_at,
        s.id AS s_id, s.watcher_id, s.kind AS s_kind, s.location, s.mode, s.status AS s_status,
        s.interval_sec, s.next_check_at, s.reconcile_at, s.etag, s.last_modified, s.cursor,
        s.failures, s.last_error, s.last_check_at
      FROM watchers w JOIN sources s ON s.watcher_id = w.id
      WHERE w.chat_id = ? AND w.status != 'stopped' ORDER BY w.id`).all(chatId) as Row[];
    return rows.map((row) => Object.freeze({
      ...watcher(row),
      source: source({ ...row, kind: row.s_kind, status: row.s_status }),
    }));
  }

  /** Operator view, including stopped watchers, newest last. Not part of the model-facing surface. */
  listAll(limit = 200): readonly (WatcherRow & { readonly source: SourceRow })[] {
    const rows = this.#db.prepare(`SELECT
        w.id AS w_id, w.chat_id, w.thread_ts, w.kind, w.target, w.label, w.status,
        w.max_events_per_hour, w.created_at, w.stopped_at,
        s.id AS s_id, s.watcher_id, s.kind AS s_kind, s.location, s.mode, s.status AS s_status,
        s.interval_sec, s.next_check_at, s.reconcile_at, s.etag, s.last_modified, s.cursor,
        s.failures, s.last_error, s.last_check_at
      FROM watchers w JOIN sources s ON s.watcher_id = w.id
      ORDER BY w.id LIMIT ?`).all(Math.max(1, Math.min(limit, 1_000))) as Row[];
    return rows.map((row) => Object.freeze({
      ...watcher(row),
      source: source({ ...row, kind: row.s_kind, status: row.s_status }),
    }));
  }

  /** Stops the watcher and its source. The conditional update makes a repeated stop a plain `false`. */
  stop(chatId: string, watcherId: number, now: string): boolean {
    return this.#transaction(() => {
      const changed = this.#db.prepare(
        `UPDATE watchers SET status = 'stopped', stopped_at = ? WHERE id = ? AND chat_id = ? AND status IN ${LIVE_STATUSES}`,
      ).run(now, watcherId, chatId);
      if (changed.changes !== 1) return false;
      this.#db.prepare(
        "UPDATE sources SET status = 'stopped', next_check_at = NULL, reconcile_at = NULL WHERE watcher_id = ?",
      ).run(watcherId);
      return true;
    });
  }

  /**
   * Claims due poll sources by moving their next check forward inside one immediate transaction.
   * Whoever moves the row owns it; a second pass in the same lease window sees nothing due.
   */
  claimDue(now: string, limit: number, leaseSeconds: number, mode: SourceMode = "poll"): readonly SourceRow[] {
    return this.#transaction(() => {
      const due = this.#db.prepare(`SELECT id FROM sources
        WHERE mode = ? AND status IN ${POLLABLE_STATUSES}
          AND next_check_at IS NOT NULL AND next_check_at <= ?
        ORDER BY next_check_at, id LIMIT ?`).all(mode, now, Math.max(1, Math.min(limit, 100))) as { id: number }[];
      const lease = iso(new Date(Date.parse(now) + Math.max(1, Math.trunc(leaseSeconds)) * 1_000));
      const claim = this.#db.prepare("UPDATE sources SET next_check_at = ? WHERE id = ? AND next_check_at <= ?");
      const claimed: SourceRow[] = [];
      for (const { id } of due) {
        if (claim.run(lease, id, now).changes === 1) claimed.push(this.#sourceById(id));
      }
      return claimed;
    });
  }

  /**
   * Applies a successful check. A source whose `last_check_at` is still NULL has never completed one,
   * so this is its baseline: the keys are recorded (they become dedupe markers) but no outbox row is
   * queued. A failed first check therefore leaves the source in baseline, and its later recovery
   * cannot replay history.
   */
  finish(sourceId: number, result: SourceCheckResult, now: string, nextCheckAt: string): number {
    return this.#transaction(() => {
      const current = this.#sourceById(sourceId);
      const owner = this.#watcherById(current.watcherId);
      const baseline = current.lastCheckAt === null;
      const insertEvent = this.#db.prepare(`INSERT OR IGNORE INTO events
        (source_id, dedup_key, delivery_id, kind, occurred_at, received_at, facts)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const insertOutbox = this.#db.prepare(`INSERT INTO outbox
        (watcher_id, event_id, chat_id, thread_ts, text, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`);
      let queued = 0;
      for (const event of result.events) {
        const inserted = insertEvent.run(
          sourceId,
          event.dedupKey,
          event.deliveryId ?? null,
          event.kind,
          event.occurredAt,
          now,
          JSON.stringify(event.facts),
        );
        if (inserted.changes !== 1 || baseline) continue;
        insertOutbox.run(
          owner.id,
          Number(inserted.lastInsertRowid),
          owner.chatId,
          owner.threadTs,
          event.text.slice(0, OUTBOX_TEXT_MAX_CHARS),
          now,
        );
        queued += 1;
      }
      this.#db.prepare(`UPDATE sources SET
          status = 'active', next_check_at = ?, failures = 0, last_error = NULL, last_check_at = ?,
          etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), cursor = COALESCE(?, cursor)
        WHERE id = ?`).run(
        nextCheckAt,
        now,
        result.state?.etag ?? null,
        result.state?.lastModified ?? null,
        result.state?.cursor ?? null,
        sourceId,
      );
      return queued;
    });
  }

  /**
   * Applies a failed check. The caller computes the backoff from the failures it read before this
   * call; the store only records the outcome. Five consecutive failures become `error`, which is
   * still claimable at the hourly probe cadence; a gone source is stopped for good.
   *
   * `last_check_at` is deliberately left alone: it marks the last *successful* check, which is what
   * tells `finish` that the source is still establishing its baseline. A watch whose first checks
   * all failed must still baseline when it recovers, never replay the history it missed.
   */
  fail(sourceId: number, code: string, now: string, nextCheckAt: string): void {
    void now;
    this.#transaction(() => {
      const current = this.#sourceById(sourceId);
      const failures = current.failures + 1;
      const gone = code === "WATCH_SOURCE_GONE";
      const status: SourceStatus = gone ? "stopped" : failures >= 5 ? "error" : "backoff";
      this.#db.prepare(`UPDATE sources SET
          status = ?, failures = ?, last_error = ?, next_check_at = ?
        WHERE id = ?`).run(
        status,
        failures,
        code.slice(0, 64),
        gone ? null : nextCheckAt,
        sourceId,
      );
    });
  }

  /** One event from a push source: insert-or-ignore, then queue its message in the same transaction. */
  ingest(sourceId: number, event: WatchEventInput, now: string): boolean {
    return this.#transaction(() => {
      const owner = this.#watcherById(this.#sourceById(sourceId).watcherId);
      const inserted = this.#db.prepare(`INSERT OR IGNORE INTO events
        (source_id, dedup_key, delivery_id, kind, occurred_at, received_at, facts)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        sourceId,
        event.dedupKey,
        event.deliveryId ?? null,
        event.kind,
        event.occurredAt,
        now,
        JSON.stringify(event.facts),
      );
      if (inserted.changes !== 1) return false;
      this.#db.prepare(`INSERT INTO outbox
        (watcher_id, event_id, chat_id, thread_ts, text, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(
        owner.id,
        Number(inserted.lastInsertRowid),
        owner.chatId,
        owner.threadTs,
        event.text.slice(0, OUTBOX_TEXT_MAX_CHARS),
        now,
      );
      return true;
    });
  }

  pending(limit: number): readonly OutboxRow[] {
    return (this.#db.prepare("SELECT * FROM outbox WHERE status = 'pending' ORDER BY id LIMIT ?")
      .all(Math.max(1, Math.min(limit, 500))) as Row[]).map(outbox);
  }

  claimOutbox(id: number): boolean {
    const changed = this.#db.prepare(
      "UPDATE outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
    ).run(id);
    return changed.changes === 1;
  }

  sent(id: number, messageId: string, now: string): void {
    const changed = this.#db.prepare(
      "UPDATE outbox SET status = 'sent', message_id = ?, sent_at = ? WHERE id = ? AND status = 'sending'",
    ).run(messageId, now, id);
    if (changed.changes !== 1) throw new WatcherError("WATCH_STORE_ERROR", "the outbox row is not sending");
  }

  failed(id: number, code: string, now: string, uncertain: boolean): void {
    this.#db.prepare(
      "UPDATE outbox SET status = ?, failure_code = ? WHERE id = ? AND status = 'sending'",
    ).run(uncertain ? "uncertain" : "failed", code.slice(0, 64), id);
  }

  /**
   * Startup recovery: a row left in `sending` may have reached the channel before the process died,
   * so it becomes `uncertain` and is never resent automatically.
   */
  recoverInterrupted(now: string): number {
    void now;
    return Number(this.#db.prepare(
      "UPDATE outbox SET status = 'uncertain', failure_code = 'PROCESS_INTERRUPTED' WHERE status = 'sending'",
    ).run().changes);
  }

  /**
   * Push sources whose reconcile is due. Claiming moves `reconcile_at` forward by the source's own
   * interval, so a slow reconcile is not handed to the next pass while it is still running.
   */
  dueReconcile(now: string, limit: number): readonly SourceRow[] {
    return this.#transaction(() => {
      const due = this.#db.prepare(`SELECT id, interval_sec FROM sources
        WHERE mode = 'push' AND status IN ${POLLABLE_STATUSES}
          AND reconcile_at IS NOT NULL AND reconcile_at <= ?
        ORDER BY reconcile_at, id LIMIT ?`).all(now, Math.max(1, Math.min(limit, 100))) as { id: number; interval_sec: number }[];
      const advance = this.#db.prepare("UPDATE sources SET reconcile_at = ? WHERE id = ? AND reconcile_at <= ?");
      const claimed: SourceRow[] = [];
      for (const row of due) {
        const next = iso(new Date(Date.parse(now) + Math.max(1, Number(row.interval_sec)) * 1_000));
        if (advance.run(next, row.id, now).changes === 1) claimed.push(this.#sourceById(row.id));
      }
      return claimed;
    });
  }

  /** How many messages this chat has had delivered since `since`. Used for the hourly merge cap. */
  sentCount(chatId: string, since: string): number {
    return Number((this.#db.prepare(
      "SELECT COUNT(*) AS n FROM outbox WHERE chat_id = ? AND status = 'sent' AND sent_at >= ?",
    ).get(chatId, since) as { n: number }).n);
  }

  close(): void {
    this.#db.close();
  }

  #sourceById(id: number): SourceRow {
    const record = this.#db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
    if (record === undefined) throw new WatcherError("WATCH_STORE_ERROR", `source ${id} does not exist`);
    return source(record as Row);
  }

  #watcherById(id: number): WatcherRow {
    const record = this.#db.prepare("SELECT * FROM watchers WHERE id = ?").get(id);
    if (record === undefined) throw new WatcherError("WATCH_STORE_ERROR", `watcher ${id} does not exist`);
    return watcher(record as Row);
  }

  #transaction<T>(operation: () => T): T {
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
