import { DatabaseSync } from "node:sqlite";
import {
  WATCH_REASON_CODES,
  WATCH_SCHEMA_SQL,
  type CreateWatcherInput,
  type OutboxRow,
  type SourceCheckResult,
  type SourceMode,
  type SourceRow,
  type SourceState,
  type SourceStatus,
  type WatchEventInput,
  type WatchKind,
  type WatchReasonCode,
  type WatchStore,
  type WatcherRow,
} from "./protocol.js";

/**
 * Durable state for watchers.
 *
 * The scheduler is not the source of truth: every claim is a conditional update inside one immediate
 * transaction, so a slow tick, a restart, or a second process that opened the same file cannot send
 * the same event twice. A source that has never completed a successful check (`last_check_at IS
 * NULL`) is in baseline mode: events are recorded as *seen* but never queued, which is what keeps a
 * newly created watcher — or one recovering from its first failure — from replaying history. Delivery
 * is an outbox, so the same message is produced once whether the event arrived by webhook or polling.
 */

export class WatchError extends Error {
  constructor(readonly code: WatchReasonCode, message: string) {
    super(message);
    this.name = "WatchError";
  }
}

/** Any error carrying a reason code this feature understands, or the store fallback. */
export function watchReasonCode(error: unknown): WatchReasonCode {
  if (error instanceof WatchError) return error.code;
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && (WATCH_REASON_CODES as readonly string[]).includes(code)) {
      return code as WatchReasonCode;
    }
  }
  return "WATCH_STORE_ERROR";
}

const KINDS: readonly WatchKind[] = ["github_run", "github_pr", "github_events", "feed", "x"];
const MAX_TEXT_CHARS = 2_000;

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new WatchError("WATCH_TARGET_INVALID", `${field} must not be empty`);
  if (trimmed.length > 2_000) throw new WatchError("WATCH_TARGET_INVALID", `${field} is too long`);
  return trimmed;
}

function iso(now: string): string {
  const parsed = Date.parse(now);
  if (Number.isNaN(parsed)) throw new WatchError("WATCH_STORE_ERROR", "timestamp is not a valid instant");
  return new Date(parsed).toISOString();
}

function addSeconds(now: string, seconds: number): string {
  return new Date(Date.parse(now) + seconds * 1_000).toISOString();
}

function watcherRow(record: Record<string, unknown>): WatcherRow {
  return Object.freeze({
    id: Number(record.id),
    chatId: String(record.chatId),
    threadTs: record.threadTs === null ? null : String(record.threadTs),
    kind: String(record.kind) as WatchKind,
    target: String(record.target),
    label: String(record.label),
    status: String(record.status),
    maxEventsPerHour: Number(record.maxEventsPerHour),
    createdAt: String(record.createdAt),
    stoppedAt: record.stoppedAt === null ? null : String(record.stoppedAt),
  });
}

function sourceRow(record: Record<string, unknown>): SourceRow {
  return Object.freeze({
    id: Number(record.id),
    watcherId: Number(record.watcherId),
    kind: String(record.kind) as WatchKind,
    location: String(record.location),
    mode: String(record.mode) as SourceMode,
    status: String(record.status) as SourceStatus,
    intervalSec: Number(record.intervalSec),
    nextCheckAt: record.nextCheckAt === null ? null : String(record.nextCheckAt),
    reconcileAt: record.reconcileAt === null ? null : String(record.reconcileAt),
    etag: record.etag === null ? null : String(record.etag),
    lastModified: record.lastModified === null ? null : String(record.lastModified),
    cursor: record.cursor === null ? null : String(record.cursor),
    failures: Number(record.failures),
    lastError: record.lastError === null ? null : String(record.lastError),
    lastCheckAt: record.lastCheckAt === null ? null : String(record.lastCheckAt),
  });
}

function outboxRow(record: Record<string, unknown>): OutboxRow {
  return Object.freeze({
    id: Number(record.id),
    watcherId: Number(record.watcherId),
    eventId: Number(record.eventId),
    chatId: String(record.chatId),
    threadTs: record.threadTs === null ? null : String(record.threadTs),
    text: String(record.text),
    status: String(record.status) as OutboxRow["status"],
    attempts: Number(record.attempts),
    createdAt: String(record.createdAt),
  });
}

const SOURCE_COLUMNS = `s.id AS id, s.watcher_id AS watcherId, s.kind AS kind, s.location AS location,
  s.mode AS mode, s.status AS status, s.interval_sec AS intervalSec, s.next_check_at AS nextCheckAt,
  s.reconcile_at AS reconcileAt, s.etag AS etag, s.last_modified AS lastModified, s.cursor AS cursor,
  s.failures AS failures, s.last_error AS lastError, s.last_check_at AS lastCheckAt`;
const WATCHER_COLUMNS = `w.id AS id, w.chat_id AS chatId, w.thread_ts AS threadTs, w.kind AS kind,
  w.target AS target, w.label AS label, w.status AS status, w.max_events_per_hour AS maxEventsPerHour,
  w.created_at AS createdAt, w.stopped_at AS stoppedAt`;
const OUTBOX_COLUMNS = `id, watcher_id AS watcherId, event_id AS eventId, chat_id AS chatId,
  thread_ts AS threadTs, text, status, attempts, created_at AS createdAt`;

/**
 * The runtime's store surface: the protocol's interface plus the operations the scheduler and the
 * delivery loop need but that are not part of the seam between the two halves.
 */
export interface WatchRuntimeStore extends WatchStore {
  /** A conditional GET proved reachability without changing the failure state. */
  unchanged(sourceId: number, state: SourceState, now: string, nextCheckAt: string): void;
  liveCount(chatId: string): number;
  listAll(limit?: number): readonly (WatcherRow & { readonly source: SourceRow })[];
  sources(mode: SourceMode): readonly SourceRow[];
  relayCursor(): string | null;
  advanceRelay(cursor: string, now: string): void;
  resetRelayCursor(): void;
  pendingForChat(chatId: string, limit: number): readonly OutboxRow[];
  sentLastHour(chatId: string, since: string): number;
}

/** Lease for a claim: long enough for one fetch, short enough that a crash is retried soon. */
const CLAIM_LEASE_SECONDS = 120;

export class SqliteWatchStore implements WatchRuntimeStore {
  readonly #db: DatabaseSync;

  constructor(path: string, options: { readonly readOnly?: boolean } = {}) {
    this.#db = new DatabaseSync(path, options.readOnly === true ? { readOnly: true } : {});
    if (options.readOnly === true) {
      // The operator CLI never migrates or writes; it only needs a consistent view.
      this.#db.exec("PRAGMA busy_timeout = 5000");
      return;
    }
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    for (const statement of WATCH_SCHEMA_SQL) this.#db.exec(statement);
  }

  create(input: CreateWatcherInput): { watcherId: number; sourceId: number } {
    const chatId = requireText(input.chatId, "chatId");
    const target = requireText(input.target, "target");
    const label = requireText(input.label, "label");
    const location = requireText(input.location, "location");
    if (!KINDS.includes(input.kind)) throw new WatchError("WATCH_TARGET_INVALID", "unknown watch kind");
    if (!Number.isInteger(input.intervalSec) || input.intervalSec < 30 || input.intervalSec > 86_400) {
      throw new WatchError("WATCH_TARGET_INVALID", "interval is outside the supported range");
    }
    if ((input.kind === "feed" || input.kind === "x") !== (input.mode === "poll")) {
      throw new WatchError("WATCH_TARGET_INVALID", "source mode does not match the watch kind");
    }
    const now = iso(input.now);
    return this.#transaction(() => {
      const live = this.#db.prepare(
        "SELECT id FROM watchers WHERE chat_id = ? AND kind = ? AND target = ? AND status IN ('active', 'paused')",
      ).get(chatId, input.kind, target);
      if (live !== undefined) throw new WatchError("WATCH_DUPLICATE", "this target is already being watched");
      const inserted = this.#db.prepare(`INSERT INTO watchers
        (chat_id, thread_ts, kind, target, label, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?)`).run(
        chatId, input.threadTs ?? null, input.kind, target, label, now,
      );
      const watcherId = Number(inserted.lastInsertRowid);
      // A poll source is due immediately; a push source's first reconcile is its baseline.
      const due = input.mode === "poll" ? now : null;
      const reconcile = input.mode === "push" ? now : null;
      const source = this.#db.prepare(`INSERT INTO sources
        (watcher_id, kind, location, mode, status, interval_sec, next_check_at, reconcile_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`).run(
        watcherId, input.kind, location, input.mode, input.intervalSec, due, reconcile,
      );
      return { watcherId, sourceId: Number(source.lastInsertRowid) };
    });
  }

  list(chatId: string): readonly (WatcherRow & { readonly source: SourceRow })[] {
    const rows = this.#db.prepare(`SELECT ${WATCHER_COLUMNS}, ${SOURCE_COLUMNS}
      FROM watchers w JOIN sources s ON s.watcher_id = w.id
      WHERE w.chat_id = ? AND w.status != 'stopped' ORDER BY w.id`).all(chatId) as Record<string, unknown>[];
    return rows.map((row) => ({ ...watcherRow(row), source: sourceRow(row) }));
  }

  /** Operator view, including stopped rows and the source they own. */
  listAll(limit = 200): readonly (WatcherRow & { readonly source: SourceRow })[] {
    const rows = this.#db.prepare(`SELECT ${WATCHER_COLUMNS}, ${SOURCE_COLUMNS}
      FROM watchers w JOIN sources s ON s.watcher_id = w.id
      ORDER BY CASE w.status WHEN 'stopped' THEN 1 ELSE 0 END, w.id LIMIT ?`)
      .all(Math.max(1, Math.min(limit, 1_000))) as Record<string, unknown>[];
    return rows.map((row) => ({ ...watcherRow(row), source: sourceRow(row) }));
  }

  /** Live watcher count for a chat; the tool layer applies `maxActive` with this. */
  liveCount(chatId: string): number {
    return Number((this.#db.prepare(
      "SELECT COUNT(*) AS n FROM watchers WHERE chat_id = ? AND status IN ('active', 'paused')",
    ).get(chatId) as { n: number }).n);
  }

  stop(chatId: string, watcherId: number, now: string): boolean {
    const stoppedAt = iso(now);
    return this.#transaction(() => {
      const changed = this.#db.prepare(`UPDATE watchers SET status = 'stopped', stopped_at = ?
        WHERE id = ? AND chat_id = ? AND status != 'stopped'`).run(stoppedAt, watcherId, chatId);
      if (changed.changes !== 1) return false;
      this.#db.prepare(`UPDATE sources SET status = 'stopped', next_check_at = NULL, reconcile_at = NULL
        WHERE watcher_id = ?`).run(watcherId);
      return true;
    });
  }

  claimDue(now: string, limit: number, leaseSeconds = CLAIM_LEASE_SECONDS): readonly SourceRow[] {
    const at = iso(now);
    const lease = addSeconds(at, Math.max(1, Math.min(leaseSeconds, 3_600)));
    return this.#transaction(() => {
      const rows = this.#db.prepare(`SELECT ${SOURCE_COLUMNS}
        FROM sources s JOIN watchers w ON w.id = s.watcher_id
        WHERE s.mode = 'poll' AND s.status IN ('active', 'backoff', 'error')
          AND s.next_check_at IS NOT NULL AND s.next_check_at <= ? AND w.status != 'stopped'
        ORDER BY s.next_check_at, s.id LIMIT ?`).all(at, Math.max(1, Math.min(limit, 100))) as Record<string, unknown>[];
      const claim = this.#db.prepare(`UPDATE sources SET next_check_at = ?
        WHERE id = ? AND next_check_at IS NOT NULL AND next_check_at <= ?`);
      const claimed: SourceRow[] = [];
      for (const row of rows) {
        if (claim.run(lease, Number(row.id), at).changes === 1) claimed.push(sourceRow(row));
      }
      return claimed;
    });
  }

  finish(sourceId: number, result: SourceCheckResult, now: string, nextCheckAt: string): number {
    const at = iso(now);
    const next = iso(nextCheckAt);
    return this.#transaction(() => {
      const source = this.#sourceRow(sourceId);
      const watcher = source === undefined ? undefined : this.#watcherRow(source.watcherId);
      if (source === undefined || watcher === undefined) {
        throw new WatchError("WATCH_STORE_ERROR", "watch source was not found");
      }
      // `last_check_at` is written only on success, so a failed first check keeps the source in
      // baseline mode and its recovery cannot replay history.
      const baseline = source.lastCheckAt === null;
      let added = 0;
      for (const event of result.events) {
        if (this.#insertEvent(source, watcher, event, at, baseline)) added += 1;
      }
      const state = result.state;
      this.#db.prepare(`UPDATE sources SET etag = ?, last_modified = ?, cursor = ?,
        failures = 0, last_error = NULL, last_check_at = ?, status = 'active',
        next_check_at = ?, reconcile_at = ? WHERE id = ?`).run(
        state?.etag ?? source.etag,
        state?.lastModified ?? source.lastModified,
        state?.cursor ?? source.cursor,
        at,
        source.mode === "poll" ? next : null,
        source.mode === "push" ? next : null,
        sourceId,
      );
      return baseline ? 0 : added;
    });
  }

  /**
   * A conditional GET answered 304. It proves the source is reachable but carries no change, so it
   * must not clear a failure counter or a backoff that was already earned.
   */
  unchanged(sourceId: number, state: SourceState, now: string, nextCheckAt: string): void {
    const at = iso(now);
    const next = iso(nextCheckAt);
    this.#transaction(() => {
      const source = this.#sourceRow(sourceId);
      if (source === undefined) throw new WatchError("WATCH_STORE_ERROR", "watch source was not found");
      this.#db.prepare(`UPDATE sources SET etag = ?, last_modified = ?, cursor = ?, last_check_at = ?,
        next_check_at = ?, reconcile_at = ? WHERE id = ?`).run(
        state.etag ?? source.etag,
        state.lastModified ?? source.lastModified,
        state.cursor ?? source.cursor,
        at,
        source.mode === "poll" ? next : null,
        source.mode === "push" ? next : null,
        sourceId,
      );
    });
  }

  fail(sourceId: number, code: string, now: string, nextCheckAt: string): void {
    const at = iso(now);
    const next = iso(nextCheckAt);
    this.#transaction(() => {
      const source = this.#sourceRow(sourceId);
      if (source === undefined) throw new WatchError("WATCH_STORE_ERROR", "watch source was not found");
      const failures = source.failures + 1;
      const gone = code === "WATCH_SOURCE_GONE";
      const status = gone ? "stopped" : failures >= 5 ? "error" : "backoff";
      this.#db.prepare(`UPDATE sources SET failures = ?, last_error = ?, status = ?,
        next_check_at = ?, reconcile_at = ? WHERE id = ?`).run(
        failures,
        code.slice(0, 64),
        status,
        source.mode === "poll" && !gone ? next : null,
        source.mode === "push" && !gone ? next : null,
        sourceId,
      );
    });
  }

  ingest(sourceId: number, event: WatchEventInput, now: string): boolean {
    const at = iso(now);
    return this.#transaction(() => {
      const source = this.#sourceRow(sourceId);
      const watcher = source === undefined ? undefined : this.#watcherRow(source.watcherId);
      if (source === undefined || watcher === undefined) {
        throw new WatchError("WATCH_STORE_ERROR", "watch source was not found");
      }
      return this.#insertEvent(source, watcher, event, at, source.lastCheckAt === null);
    });
  }

  pending(limit: number): readonly OutboxRow[] {
    return (this.#db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox
      WHERE status = 'pending' ORDER BY id LIMIT ?`)
      .all(Math.max(1, Math.min(limit, 200))) as Record<string, unknown>[]).map(outboxRow);
  }

  pendingForChat(chatId: string, limit: number): readonly OutboxRow[] {
    return (this.#db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox
      WHERE chat_id = ? AND status = 'pending' ORDER BY id LIMIT ?`)
      .all(chatId, Math.max(1, Math.min(limit, 200))) as Record<string, unknown>[]).map(outboxRow);
  }

  claimOutbox(id: number): boolean {
    const changed = this.#db.prepare(
      "UPDATE outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
    ).run(id);
    return changed.changes === 1;
  }

  sent(id: number, messageId: string, now: string): void {
    const changed = this.#db.prepare(`UPDATE outbox SET status = 'sent', message_id = ?, sent_at = ?,
      failure_code = NULL WHERE id = ? AND status = 'sending'`)
      .run(messageId.slice(0, 256), iso(now), id);
    if (changed.changes !== 1) throw new WatchError("WATCH_STORE_ERROR", "outbox row is not being sent");
  }

  failed(id: number, code: string, now: string, uncertain: boolean): void {
    const changed = this.#db.prepare(`UPDATE outbox SET status = ?, failure_code = ?, sent_at = ?
      WHERE id = ? AND status = 'sending'`)
      .run(uncertain ? "uncertain" : "failed", code.slice(0, 64), iso(now), id);
    if (changed.changes !== 1) throw new WatchError("WATCH_STORE_ERROR", "outbox row is not being sent");
  }

  recoverInterrupted(now: string): number {
    void now;
    const changed = this.#db.prepare(`UPDATE outbox SET status = 'uncertain', failure_code = 'PROCESS_INTERRUPTED'
      WHERE status = 'sending'`).run();
    return Number(changed.changes);
  }

  dueReconcile(now: string, limit: number): readonly SourceRow[] {
    const at = iso(now);
    return this.#transaction(() => {
      const rows = this.#db.prepare(`SELECT ${SOURCE_COLUMNS}
        FROM sources s JOIN watchers w ON w.id = s.watcher_id
        WHERE s.mode = 'push' AND s.status IN ('active', 'backoff', 'error')
          AND s.reconcile_at IS NOT NULL AND s.reconcile_at <= ? AND w.status != 'stopped'
        ORDER BY s.reconcile_at, s.id LIMIT ?`).all(at, Math.max(1, Math.min(limit, 100))) as Record<string, unknown>[];
      const claim = this.#db.prepare("UPDATE sources SET reconcile_at = ? WHERE id = ? AND reconcile_at <= ?");
      const claimed: SourceRow[] = [];
      for (const row of rows) {
        if (claim.run(addSeconds(at, 60), Number(row.id), at).changes === 1) claimed.push(sourceRow(row));
      }
      return claimed;
    });
  }

  /** Sources of one mode, used by the relay to route deliveries and by reconcile to enumerate. */
  sources(mode: SourceMode): readonly SourceRow[] {
    return (this.#db.prepare(`SELECT ${SOURCE_COLUMNS}
      FROM sources s JOIN watchers w ON w.id = s.watcher_id
      WHERE s.mode = ? AND s.status != 'stopped' AND w.status != 'stopped'
      ORDER BY s.id`).all(mode) as Record<string, unknown>[]).map(sourceRow);
  }

  /** The shared relay cursor. Every push source carries it, so any missing value means a baseline pull. */
  relayCursor(): string | null {
    const rows = this.#db.prepare("SELECT cursor FROM sources WHERE mode = 'push' AND status != 'stopped'")
      .all() as { cursor: string | null }[];
    if (rows.length === 0 || rows.some((row) => row.cursor === null)) return null;
    const values = rows.map((row) => Number(row.cursor));
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
    return String(Math.min(...values));
  }

  /**
   * The relay consumed deliveries through `cursor`. Recording it on every push source keeps the
   * shared cursor one value, and a successful pull also clears failures the last check left behind.
   */
  advanceRelay(cursor: string, now: string): void {
    const at = iso(now);
    this.#db.prepare(`UPDATE sources SET cursor = ?, last_check_at = ?, failures = 0, last_error = NULL,
      status = CASE WHEN status = 'stopped' THEN status ELSE 'active' END WHERE mode = 'push'`).run(cursor, at);
  }

  /** A cursor gap means deliveries were lost; the next pull starts from the relay tail and reconcile fills in. */
  resetRelayCursor(): void {
    this.#db.prepare("UPDATE sources SET cursor = NULL WHERE mode = 'push' AND status != 'stopped'").run();
  }

  sentLastHour(chatId: string, since: string): number {
    return Number((this.#db.prepare(`SELECT COUNT(*) AS n FROM outbox
      WHERE chat_id = ? AND status = 'sent' AND sent_at >= ?`).get(chatId, iso(since)) as { n: number }).n);
  }

  close(): void {
    this.#db.close();
  }

  #watcherRow(id: number): WatcherRow | undefined {
    const record = this.#db.prepare(`SELECT ${WATCHER_COLUMNS} FROM watchers w WHERE w.id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return record === undefined ? undefined : watcherRow(record);
  }

  #sourceRow(id: number): SourceRow | undefined {
    const record = this.#db.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return record === undefined ? undefined : sourceRow(record);
  }

  #insertEvent(source: SourceRow, watcher: WatcherRow, event: WatchEventInput, now: string, baseline: boolean): boolean {
    const inserted = this.#db.prepare(`INSERT OR IGNORE INTO events
      (source_id, dedup_key, delivery_id, kind, occurred_at, received_at, facts)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      source.id,
      event.dedupKey,
      event.deliveryId ?? null,
      event.kind,
      event.occurredAt,
      now,
      JSON.stringify(event.facts),
    );
    if (inserted.changes !== 1) return false;
    // Baseline: the key is remembered so it cannot be delivered later, but nothing is queued.
    if (baseline) return true;
    const text = event.text.length > MAX_TEXT_CHARS ? event.text.slice(0, MAX_TEXT_CHARS) : event.text;
    this.#db.prepare(`INSERT INTO outbox
      (watcher_id, event_id, chat_id, thread_ts, text, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(
      watcher.id,
      Number(inserted.lastInsertRowid),
      watcher.chatId,
      watcher.threadTs,
      `[跟踪 #${watcher.id}] ${text}`,
      now,
    );
    return true;
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
