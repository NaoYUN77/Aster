import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * `web.sqlite`: session and request state for the web adapter.
 *
 * This database never stores chat history. The durable transcript (`agent.sqlite`) remains the only
 * history source; `web_requests` exists for status, idempotency and short-lived retry state only.
 */

export type WebRequestStatus = "queued" | "running" | "done" | "failed" | "aborted";

export type ModelRefView = { readonly id: string; readonly label: string };
export type RequestedModelView = ModelRefView & { readonly kind: "primary" | "manual" | "auto" };
export type RequestModelInfo = {
  readonly requested: RequestedModelView | null;
  readonly actual: ModelRefView | null;
  readonly kind: "primary" | "manual" | "auto" | null;
  readonly degraded: boolean;
};

export type WebRequestRow = {
  readonly request_id: string;
  readonly client_message_id: string;
  readonly text: string;
  readonly status: WebRequestStatus;
  readonly reply: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly requested_model: string | null;
  readonly actual_model: string | null;
  readonly model_kind: string | null;
  readonly degraded: number;
  readonly created_at: number;
  readonly started_at: number | null;
  readonly finished_at: number | null;
};

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class WebRequestStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS web_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        label TEXT
      );
      CREATE INDEX IF NOT EXISTS web_sessions_expiry ON web_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS web_requests (
        request_id TEXT PRIMARY KEY,
        client_message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        reply TEXT,
        error_code TEXT,
        error_message TEXT,
        requested_model TEXT,
        actual_model TEXT,
        model_kind TEXT,
        degraded INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS web_requests_client ON web_requests(client_message_id);
      CREATE INDEX IF NOT EXISTS web_requests_status ON web_requests(status, created_at);
    `);
    // A crash cannot leave a half-finished generation in flight. The durable turn may have completed
    // partially, so v1 reports it instead of replaying it and risking a duplicate round.
    this.db.prepare(`
      UPDATE web_requests
         SET status = 'failed', error_code = 'PROCESS_INTERRUPTED',
             error_message = '服务重启，请重试', finished_at = ?
       WHERE status = 'running'
    `).run(Date.now());
  }

  get database(): DatabaseSync {
    return this.db;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  enqueue(clientMessageId: string, text: string): { row: WebRequestRow; created: boolean } {
    const existing = this.db.prepare("SELECT * FROM web_requests WHERE client_message_id = ?").get(clientMessageId) as
      | WebRequestRow
      | undefined;
    if (existing !== undefined) return { row: existing, created: false };
    const requestId = `req_${randomBytes(12).toString("base64url")}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO web_requests (request_id, client_message_id, text, status, created_at)
      VALUES (?, ?, ?, 'queued', ?)
    `).run(requestId, clientMessageId, text, now);
    const row = this.get(requestId)!;
    return { row, created: true };
  }

  get(requestId: string): WebRequestRow | undefined {
    return this.db.prepare("SELECT * FROM web_requests WHERE request_id = ?").get(requestId) as
      | WebRequestRow
      | undefined;
  }

  /** The client idempotency key of one request, used to link durable history rows. */
  clientMessageId(requestId: string): string | undefined {
    const row = this.db.prepare("SELECT client_message_id FROM web_requests WHERE request_id = ?").get(requestId) as
      | { client_message_id: string }
      | undefined;
    return row?.client_message_id;
  }

  /** The single running request, if any. Used by the SSE snapshot. */
  active(): WebRequestRow | undefined {
    return this.db.prepare("SELECT * FROM web_requests WHERE status = 'running' ORDER BY started_at LIMIT 1").get() as
      | WebRequestRow
      | undefined;
  }

  /** Claim the oldest queued request for this process. Single process, so no lease is needed. */
  claimNext(): WebRequestRow | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM web_requests WHERE status = 'queued'
        ORDER BY created_at, rowid LIMIT 1
      `).get() as WebRequestRow | undefined;
      if (row === undefined) return undefined;
      const startedAt = Date.now();
      this.db.prepare("UPDATE web_requests SET status = 'running', started_at = ? WHERE request_id = ? AND status = 'queued'")
        .run(startedAt, row.request_id);
      return this.get(row.request_id);
    });
  }

  markDone(requestId: string, reply: string, model: RequestModelInfo): boolean {
    const result = this.db.prepare(`
      UPDATE web_requests
         SET status = 'done', reply = ?, requested_model = ?, actual_model = ?, model_kind = ?,
             degraded = ?, finished_at = ?
       WHERE request_id = ? AND status = 'running'
    `).run(
      reply,
      model.requested === null ? null : JSON.stringify(model.requested),
      model.actual === null ? null : JSON.stringify(model.actual),
      model.kind,
      model.degraded ? 1 : 0,
      Date.now(),
      requestId,
    );
    return Number(result.changes) === 1;
  }

  markFailed(requestId: string, code: string, message: string, model?: RequestModelInfo): boolean {
    const result = this.db.prepare(`
      UPDATE web_requests
         SET status = 'failed', error_code = ?, error_message = ?, requested_model = ?,
             actual_model = ?, model_kind = ?, degraded = ?, finished_at = ?
       WHERE request_id = ? AND status = 'running'
    `).run(
      code,
      message,
      model?.requested === undefined || model.requested === null ? null : JSON.stringify(model.requested),
      model?.actual === undefined || model.actual === null ? null : JSON.stringify(model.actual),
      model?.kind ?? null,
      model?.degraded ? 1 : 0,
      Date.now(),
      requestId,
    );
    return Number(result.changes) === 1;
  }

  /**
   * Mark a request aborted. A queued request is withdrawn; a running one is only marked here so the
   * worker's late completion cannot turn it into `done`. Returns the status it had, if any.
   */
  markAborted(requestId: string): { found: boolean; previous: WebRequestStatus | null } {
    return this.transaction(() => {
      const row = this.get(requestId);
      if (row === undefined) return { found: false, previous: null };
      if (row.status !== "queued" && row.status !== "running") return { found: true, previous: row.status };
      this.db.prepare(`
        UPDATE web_requests SET status = 'aborted', finished_at = ? WHERE request_id = ?
      `).run(Date.now(), requestId);
      return { found: true, previous: row.status };
    });
  }

  /** True while the request still holds the running slot (an abort clears it). */
  isRunning(requestId: string): boolean {
    const row = this.db.prepare("SELECT status FROM web_requests WHERE request_id = ?").get(requestId) as
      | { status: string }
      | undefined;
    return row?.status === "running";
  }

  cleanup(now = Date.now()): void {
    this.db.prepare(`
      DELETE FROM web_requests
       WHERE status IN ('done', 'failed', 'aborted')
         AND finished_at IS NOT NULL
         AND finished_at < ?
    `).run(now - RETENTION_MS);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
