import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventHub } from "../http/events.js";
import type { ApprovalCaller, ApprovalEvaluation, ApprovalRuleId } from "./policy.js";

export type ApprovalDecision = "approve_once" | "approve_similar" | "deny";

export type ApprovalStatus =
  | "pending"
  | "approved_once"
  | "approved_similar"
  | "denied"
  | "expired"
  | "aborted"
  | "interrupted";

export type ApprovalRequestView = {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly caller: ApprovalCaller;
  readonly toolName: string;
  readonly args: unknown;
  readonly rule: ApprovalRuleId;
  readonly reason: string;
  readonly categoryKey: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly resolvedAt: string | null;
  readonly decisionReason: string | null;
};

export type RequestApprovalInput = {
  readonly runScopeId: string;
  readonly caller: ApprovalCaller;
  readonly toolName: string;
  readonly args: unknown;
  readonly evaluation: Extract<ApprovalEvaluation, { readonly sensitive: true }>;
};

export type ApprovalOutcome =
  | { readonly allowed: true; readonly cached?: boolean; readonly approvalId?: string }
  | { readonly allowed: false; readonly reason: string; readonly approvalId?: string };

export type ApprovalServiceOptions = {
  /** SQLite file path (or `:memory:` for tests). */
  readonly dbPath: string;
  /** Optional SSE hub for broadcasting `approval.requested` / `approval.resolved`. */
  readonly hub?: EventHub;
  /** Default pending timeout in milliseconds. Defaults to 30 minutes. */
  readonly defaultTimeoutMs?: number;
  /** Notified whenever the count of active approval waits transitions 0 <-> >0. */
  readonly onWaitActiveChange?: (waiting: boolean) => void;
  /** Process shutdown signal: aborts occurring after shutdown starts are recorded as `interrupted`. */
  readonly shutdownSignal?: AbortSignal;
  readonly log?: (line: string) => void;
};

type PendingWaiter = {
  readonly view: ApprovalRequestView;
  readonly runScopeId: string;
  readonly timer: NodeJS.Timeout;
  readonly cleanupAbort: () => void;
  readonly resolve: (outcome: ApprovalOutcome) => void;
  readonly reject: (error: unknown) => void;
};

type ApprovalRow = {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly run_scope_id: string;
  readonly caller_json: string;
  readonly tool_name: string;
  readonly args_json: string;
  readonly rule: ApprovalRuleId;
  readonly reason: string;
  readonly category_key: string;
  readonly summary: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly resolved_at: string | null;
  readonly decision_reason: string | null;
};

const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_ARGS_JSON_BYTES = 32_768;

function serializeArgs(args: unknown): string {
  try {
    const raw = JSON.stringify(args ?? {});
    if (Buffer.byteLength(raw, "utf8") <= MAX_ARGS_JSON_BYTES) return raw;
    return JSON.stringify({ _truncated: true, preview: raw.slice(0, 4_000) });
  } catch {
    return JSON.stringify({ _unserializable: true });
  }
}

function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function rowToView(row: ApprovalRow): ApprovalRequestView {
  return {
    id: row.id,
    status: row.status,
    caller: parseJsonSafe(row.caller_json) as ApprovalCaller,
    toolName: row.tool_name,
    args: parseJsonSafe(row.args_json),
    rule: row.rule,
    reason: row.reason,
    categoryKey: row.category_key,
    summary: row.summary,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    decisionReason: row.decision_reason,
  };
}

function createAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error("Approval wait aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Durable runtime approval engine (ADR-0006).
 *
 * Persists approval requests in SQLite, routes them to the owner's single web entry via SSE,
 * suspends only the calling tool execution while observing `AbortSignal`, and marks any stale
 * `pending` rows as `interrupted` on restart (fail-safe with `pi-durable@1.5.0`).
 */
export class ApprovalService {
  private readonly db: DatabaseSync;
  private readonly hub: EventHub | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly onWaitActiveChange: ((waiting: boolean) => void) | undefined;
  private readonly shutdownSignal: AbortSignal | undefined;
  private readonly log: (line: string) => void;
  private readonly pending = new Map<string, PendingWaiter>();
  private readonly runAllowlists = new Map<string, Set<string>>();
  private readonly waitListeners = new Set<(waiting: boolean) => void>();
  private closed = false;

  constructor(options: ApprovalServiceOptions) {
    if (options.dbPath !== ":memory:") {
      mkdirSync(dirname(options.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(options.dbPath);
    this.hub = options.hub;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.onWaitActiveChange = options.onWaitActiveChange;
    this.shutdownSignal = options.shutdownSignal;
    this.log = options.log ?? ((line) => console.error(line));
    this.initSchema();
    this.markStalePendingInterrupted();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        run_scope_id TEXT NOT NULL,
        caller_json TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        rule TEXT NOT NULL,
        reason TEXT NOT NULL,
        category_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        decision_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status, created_at);
    `);
  }

  private markStalePendingInterrupted(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE approval_requests
      SET status = 'interrupted', resolved_at = ?, decision_reason = 'Process restarted before approval was resolved'
      WHERE status = 'pending'
    `).run(now);
  }

  /** Subscribe to transitions between 0 active waits and >0 active waits (used to pause turn timers). */
  subscribeWaitActive(listener: (waiting: boolean) => void): () => void {
    this.waitListeners.add(listener);
    return () => {
      this.waitListeners.delete(listener);
    };
  }

  private notifyWaitActive(waiting: boolean): void {
    this.onWaitActiveChange?.(waiting);
    for (const listener of [...this.waitListeners]) listener(waiting);
  }

  /** Number of currently suspended approval waits. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Currently pending approval requests (in creation order) for SSE snapshots & HTTP polling. */
  listPending(): ApprovalRequestView[] {
    return [...this.pending.values()].map((entry) => entry.view);
  }

  /** Lookup a persisted approval request by id (pending or historical). */
  get(id: string): ApprovalRequestView | undefined {
    const row = this.db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as ApprovalRow | undefined;
    return row === undefined ? undefined : rowToView(row);
  }

  /** Clear cached "approve similar" allowances when a turn or sub-agent run finishes. */
  clearRunScope(runScopeId: string): void {
    this.runAllowlists.delete(runScopeId);
  }

  /**
   * Persist and await owner approval for a sensitive operation.
   * Observes `signal` so conversation abort or process shutdown never hangs.
   */
  requestApproval(input: RequestApprovalInput, signal?: AbortSignal): Promise<ApprovalOutcome> {
    if (this.closed) {
      return Promise.resolve({ allowed: false, reason: "Approval service is closed" });
    }
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal));
    }

    const allowedCategories = this.runAllowlists.get(input.runScopeId);
    if (allowedCategories?.has(input.evaluation.categoryKey)) {
      return Promise.resolve({ allowed: true, cached: true });
    }

    const id = `apr_${randomBytes(12).toString("hex")}`;
    const createdAtMs = Date.now();
    const createdAt = new Date(createdAtMs).toISOString();
    const expiresAt = new Date(createdAtMs + this.defaultTimeoutMs).toISOString();
    const argsJson = serializeArgs(input.args);
    const parsedArgs = parseJsonSafe(argsJson);

    this.db.prepare(`
      INSERT INTO approval_requests (
        id, status, run_scope_id, caller_json, tool_name, args_json,
        rule, reason, category_key, summary, created_at, expires_at, resolved_at, decision_reason
      ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      id,
      input.runScopeId,
      JSON.stringify(input.caller),
      input.toolName,
      argsJson,
      input.evaluation.rule,
      input.evaluation.reason,
      input.evaluation.categoryKey,
      input.evaluation.summary,
      createdAt,
      expiresAt,
    );

    const view: ApprovalRequestView = {
      id,
      status: "pending",
      caller: input.caller,
      toolName: input.toolName,
      args: parsedArgs,
      rule: input.evaluation.rule,
      reason: input.evaluation.reason,
      categoryKey: input.evaluation.categoryKey,
      summary: input.evaluation.summary,
      createdAt,
      expiresAt,
      resolvedAt: null,
      decisionReason: null,
    };

    const wasEmpty = this.pending.size === 0;

    return new Promise<ApprovalOutcome>((resolvePromise, rejectPromise) => {
      const finalize = (
        status: Exclude<ApprovalStatus, "pending">,
        decisionReason: string | null,
      ): ApprovalRequestView => {
        const waiter = this.pending.get(id);
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          waiter.cleanupAbort();
          this.pending.delete(id);
        }
        const resolvedAt = new Date().toISOString();
        try {
          this.db.prepare(`
            UPDATE approval_requests
            SET status = ?, resolved_at = ?, decision_reason = ?
            WHERE id = ? AND status = 'pending'
          `).run(status, resolvedAt, decisionReason, id);
        } catch (error) {
          this.log(`Approval update failed (${id}): ${error instanceof Error ? error.message : String(error)}`);
        }
        const updated: ApprovalRequestView = {
          ...view,
          status,
          resolvedAt,
          decisionReason,
        };
        this.hub?.broadcast("approval.resolved", updated);
        if (this.pending.size === 0) this.notifyWaitActive(false);
        return updated;
      };

      const onAbort = () => {
        if (!this.pending.has(id)) return;
        const shuttingDown = this.closed || this.shutdownSignal?.aborted === true;
        finalize(
          shuttingDown ? "interrupted" : "aborted",
          shuttingDown ? "Process shutting down before approval was resolved" : "Execution aborted before approval",
        );
        rejectPromise(createAbortError(signal));
      };

      let cleanupAbort = () => {};
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      }

      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        finalize("expired", "Approval request timed out");
        resolvePromise({
          allowed: false,
          approvalId: id,
          reason: "审批请求已超时，操作已自动拒绝",
        });
      }, this.defaultTimeoutMs);
      timer.unref();

      this.pending.set(id, {
        view,
        runScopeId: input.runScopeId,
        timer,
        cleanupAbort,
        resolve: resolvePromise,
        reject: rejectPromise,
      });

      if (wasEmpty) this.notifyWaitActive(true);
      this.hub?.broadcast("approval.requested", view);
    });
  }

  /** Resolve a pending approval request from the owner's HTTP action. */
  resolve(
    id: string,
    input: { readonly decision: ApprovalDecision; readonly reason?: string },
  ):
    | { readonly ok: true; readonly approval: ApprovalRequestView }
    | { readonly ok: false; readonly reason: "not_found" | "already_resolved" } {
    const waiter = this.pending.get(id);
    if (waiter === undefined) {
      const existing = this.get(id);
      return { ok: false, reason: existing === undefined ? "not_found" : "already_resolved" };
    }

    clearTimeout(waiter.timer);
    waiter.cleanupAbort();
    this.pending.delete(id);

    const status: Exclude<ApprovalStatus, "pending"> =
      input.decision === "approve_once"
        ? "approved_once"
        : input.decision === "approve_similar"
          ? "approved_similar"
          : "denied";
    const trimmedReason = input.reason?.trim() || null;
    const resolvedAt = new Date().toISOString();

    this.db.prepare(`
      UPDATE approval_requests
      SET status = ?, resolved_at = ?, decision_reason = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, resolvedAt, trimmedReason, id);

    if (input.decision === "approve_similar") {
      let set = this.runAllowlists.get(waiter.runScopeId);
      if (set === undefined) {
        set = new Set<string>();
        this.runAllowlists.set(waiter.runScopeId, set);
      }
      set.add(waiter.view.categoryKey);
    }

    const updated: ApprovalRequestView = {
      ...waiter.view,
      status,
      resolvedAt,
      decisionReason: trimmedReason,
    };

    this.hub?.broadcast("approval.resolved", updated);
    if (this.pending.size === 0) this.notifyWaitActive(false);

    if (input.decision === "deny") {
      const message = trimmedReason !== null
        ? `Owner 拒绝了该敏感操作：${trimmedReason}`
        : "Owner 拒绝了该敏感操作，请改用安全方案或向 Owner 说明。";
      waiter.resolve({ allowed: false, approvalId: id, reason: message });
    } else {
      waiter.resolve({ allowed: true, approvalId: id });
    }

    return { ok: true, approval: updated };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const now = new Date().toISOString();
    for (const [id, waiter] of [...this.pending.entries()]) {
      clearTimeout(waiter.timer);
      waiter.cleanupAbort();
      this.pending.delete(id);
      try {
        this.db.prepare(`
          UPDATE approval_requests
          SET status = 'interrupted', resolved_at = ?, decision_reason = 'Service shutting down'
          WHERE id = ? AND status = 'pending'
        `).run(now, id);
      } catch {
        // Best-effort during shutdown.
      }
      waiter.reject(createAbortError());
    }
    this.runAllowlists.clear();
    this.waitListeners.clear();
    this.db.close();
  }
}
