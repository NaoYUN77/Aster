// Reaction feedback: record it, and at most once per scope ask the user what to change.
//
// Nothing here decides what an emoji *means*. The only decision the host makes is whether to disturb
// the user: a short list of plainly positive reactions is recorded and left alone, every other one —
// custom, random, a string of them — may produce one short question. What the user answers is an
// ordinary message, and how it is remembered is the existing working-memory tool's job; this module
// never rewrites an instruction, a prompt or a preference itself.
//
// The three things that are bounded here: rows per scope (the table is evidence, not history), one
// question per scope per window, and one writer — reaction events are handled inside the delivery
// loop, in the same serial frame iteration that accepts requests.

import { DatabaseSync } from "node:sqlite";
import { errorCode } from "./errors.js";

/** `off` records nothing; `observe` records signals; `ask` records and asks. */
export type StyleMode = "off" | "observe" | "ask";
export const STYLE_MODES = ["off", "observe", "ask"] as const;

/**
 * Reactions that mean "fine" plainly enough that asking about them would only be noise. The list is
 * used to decide *whether to interrupt*, never what to change: anything outside it is "ask", not
 * "the user is unhappy".
 */
export const POSITIVE_REACTIONS = new Set([
  "+1",
  "thumbsup",
  "heart",
  "tada",
  "100",
  "fire",
  "pray",
  "clap",
  "white_check_mark",
]);

/** One question per scope per this window. A silence is an answer too, so nothing re-asks. */
export const ASK_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Reaction rows kept per scope. Old ones are dropped; nothing here is long-term history. */
export const SIGNALS_PER_SCOPE = 200;

/**
 * The question itself: host text, no model call. It names what is uncertain — the emoji, not the
 * reply — and it makes not answering an explicit option.
 */
export const STYLE_ASK_TEXT = "你贴的表情我不确定是满意还是不满意。要我改什么吗？回一句就行，不理我也没关系。";

/** Why a recorded signal asked nothing. A reason code, never anything the user wrote. */
export const ASK_SKIPPED_RATE = "RATE";

/**
 * One reaction on a reply this process delivered, attributed to the request that reply answered.
 * Identity is Slack's own (`event.user`) plus the Inbox row the message resolves to, so nothing in
 * the payload can claim to be somebody else.
 */
export type StyleEvent = {
  /** Idempotency key: `style:<team>:<event_id>` — Slack redelivers unacknowledged envelopes. */
  readonly eventId: string;
  readonly kind: "added" | "removed";
  /** The conversation the answer was delivered in: the scope's first half. */
  readonly channel: string;
  /** Who asked the reply being reacted to — always the reactor here, or there is no event. */
  readonly subjectId: string;
  readonly reactorId: string;
  /** The delivered message the reaction is attached to. */
  readonly messageId: string;
  readonly requestId: string;
  readonly part?: number;
  /** Normalized emoji name. External input, validated at the transport boundary. */
  readonly emoji: string;
  /** `positive` never asks; `other` may. There is no "negative". */
  readonly polarity: "positive" | "other";
  /** Reply inside a thread: the question belongs in that same thread. */
  readonly threadTs?: string;
};

/** A stored signal, with what the host did about it. */
export type StyleRow = StyleEvent & {
  readonly askedAt: string | null;
  readonly reason: string | null;
  readonly observedAt: string;
};

/**
 * The signal table, in its own `style.sqlite`. It keeps identifiers and one emoji name per row: no
 * message text, nothing the model produced. A scope — one conversation with one person — never holds
 * more than `SIGNALS_PER_SCOPE` rows, so a workspace that reacts a lot does not grow without bound.
 */
export class StyleStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS style_signals (
        eventId TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        channel TEXT NOT NULL,
        subjectId TEXT NOT NULL,
        reactorId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        requestId TEXT NOT NULL,
        part INTEGER,
        emoji TEXT NOT NULL,
        polarity TEXT NOT NULL,
        askedAt TEXT,
        reason TEXT,
        observedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS style_signals_ask ON style_signals(channel, subjectId, askedAt);
    `);
  }

  /**
   * Stores one signal and trims its scope. Returns false when the row already existed, which is how
   * a redelivered envelope asks nothing twice.
   */
  record(event: StyleEvent, observedAt: string): boolean {
    return this.transaction(() => {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO style_signals
        (eventId, kind, channel, subjectId, reactorId, messageId, requestId, part, emoji, polarity, askedAt, reason, observedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`).run(
        event.eventId,
        event.kind,
        event.channel,
        event.subjectId,
        event.reactorId,
        event.messageId,
        event.requestId,
        event.part ?? null,
        event.emoji,
        event.polarity,
        observedAt,
      );
      if (inserted.changes === 0) return false;
      this.prune(event.channel, event.subjectId);
      return true;
    });
  }

  /** Newest rows, oldest last; what the CLI shows. Bounded by `limit`. */
  recent(limit = 50): readonly StyleRow[] {
    // SQLite rows have a null prototype; plain objects keep that detail out of every reader, and out
    // of JSON.stringify's idea of what to print.
    return (this.db.prepare("SELECT * FROM style_signals ORDER BY observedAt DESC, rowid DESC LIMIT ?")
      .all(Math.max(1, limit)) as unknown as readonly StyleRow[]).map((row) => ({ ...row }));
  }

  /** When this scope was last asked; undefined when it never was. */
  askedAt(channel: string, subjectId: string): string | undefined {
    const row = this.db.prepare("SELECT MAX(askedAt) AS askedAt FROM style_signals WHERE channel = ? AND subjectId = ?")
      .get(channel, subjectId) as unknown as { askedAt: string | null } | undefined;
    return row?.askedAt ?? undefined;
  }

  /** Marks that the question went out, so nothing asks this scope again inside the window. */
  markAsked(eventId: string, at: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE style_signals SET askedAt = ?, reason = NULL WHERE eventId = ?").run(at, eventId);
    });
  }

  /** Marks why a recorded signal asked nothing. Kept as a code, so it stays log- and print-safe. */
  markSkipped(eventId: string, reason: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE style_signals SET reason = ? WHERE eventId = ?").run(reason, eventId);
    });
  }

  /**
   * Records that this scope answered, so a reaction arriving right afterwards is still recorded but
   * asks nothing: somebody who just said "shorter, conclusion first" is not asked again for an hour.
   */
  markAnswered(channel: string, subjectId: string, at: string): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE style_signals SET askedAt = MAX(COALESCE(askedAt, ?), ?)
        WHERE channel = ? AND subjectId = ? AND kind = 'added' AND polarity = 'other'`)
        .run(at, at, channel, subjectId);
    });
  }

  /**
   * A removed reaction withdraws the question too: the mark goes away so the next reaction on that
   * message may ask again, and no stale `askedAt` keeps a scope quiet forever. Returns how many rows
   * changed, which is how the caller knows there was anything to withdraw.
   */
  clearAsked(channel: string, subjectId: string, messageId: string, emoji: string): number {
    return Number(this.transaction(() => this.db.prepare(`UPDATE style_signals SET askedAt = NULL, reason = NULL
      WHERE channel = ? AND subjectId = ? AND messageId = ? AND emoji = ?`).run(channel, subjectId, messageId, emoji).changes));
  }

  /** Newest stored signal time, or undefined when no reaction was ever recorded. */
  lastObservedAt(): string | undefined {
    const row = this.db.prepare("SELECT MAX(observedAt) AS observedAt FROM style_signals")
      .get() as unknown as { observedAt: string | null } | undefined;
    return row?.observedAt ?? undefined;
  }

  /** Rows currently held per scope; what the CLI reports as the table's bound. */
  scopeCounts(): readonly { channel: string; subjectId: string; rows: number; askedAt: string | null }[] {
    return (this.db.prepare(`SELECT channel, subjectId, COUNT(*) AS rows, MAX(askedAt) AS askedAt
      FROM style_signals GROUP BY channel, subjectId ORDER BY channel, subjectId`)
      .all() as unknown as readonly { channel: string; subjectId: string; rows: number; askedAt: string | null }[])
      .map((scope) => ({ ...scope }));
  }

  /** Keeps the newest `SIGNALS_PER_SCOPE` rows of one scope and drops the rest. */
  private prune(channel: string, subjectId: string): void {
    this.db.prepare(`DELETE FROM style_signals WHERE channel = ? AND subjectId = ? AND rowid NOT IN
      (SELECT rowid FROM style_signals WHERE channel = ? AND subjectId = ?
        ORDER BY observedAt DESC, rowid DESC LIMIT ?)`).run(channel, subjectId, channel, subjectId, SIGNALS_PER_SCOPE);
  }

  private transaction<R>(operation: () => R): R {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** How one question is sent: the channel's own send, so a member id resolves exactly as a reply's. */
export type StyleAskSender = (
  channel: string,
  text: string,
  signal: AbortSignal,
  threadTs?: string,
) => Promise<string>;

export type StyleLearningOptions = {
  readonly mode: StyleMode;
  readonly send: StyleAskSender;
  /** Absent when the deployment records nothing (mode `off`); then nothing is written. */
  readonly store?: StyleStore;
  /**
   * True when Slack cannot deliver reaction events (`reactions:read` missing). The feature degrades
   * to recording; it never pretends to ask.
   */
  readonly inert?: boolean;
  readonly log?: (line: string) => void;
  /** Host clock, injected so tests can move the window without waiting. */
  readonly now?: () => number;
};

/**
 * Turns one attributed reaction into a stored signal and, at most once per scope per window, one
 * question. Ordering is deliberate: the row is written before anything is sent, the question is sent
 * before it is marked, and a store failure is thrown rather than swallowed — an envelope whose signal
 * could not be written stays unacknowledged, exactly as an unstored request does.
 */
export class StyleLearning {
  readonly #mode: StyleMode;
  readonly #send: StyleAskSender;
  readonly #store: StyleStore | undefined;
  readonly #inert: boolean;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #noted = new Set<string>();

  constructor(options: StyleLearningOptions) {
    this.#mode = options.mode;
    this.#send = options.send;
    this.#store = options.store;
    this.#inert = options.inert === true;
    this.#log = options.log ?? ((line: string) => console.error(line));
    this.#now = options.now ?? Date.now;
  }

  get mode(): StyleMode {
    return this.#mode;
  }

  /** True when the app cannot receive reaction events, so asking is impossible however configured. */
  get inert(): boolean {
    return this.#inert;
  }

  async handle(event: StyleEvent, signal: AbortSignal): Promise<void> {
    if (this.#mode === "off" || this.#store === undefined) {
      // Slack is delivering reactions and this process is doing nothing about them. Say so once:
      // the alternative is a feature that looks broken with nothing to look at.
      this.note("off", "STYLE_EVENT_SILENT: reactions are delivered but nothing is recorded (STYLE_LEARNING=off)");
      return;
    }
    const observedAt = new Date(this.#now()).toISOString();
    // A write failure is fatal and propagates, so the caller leaves the envelope unacknowledged and
    // Slack redelivers. It is named here first: the process is about to stop, and the reason has to
    // be in the log rather than buried in a stack nobody reads.
    let recorded: boolean;
    try {
      recorded = this.#store.record(event, observedAt);
    } catch (error) {
      this.#log(`STYLE_STORE_FAILED: ${errorCode(error)}`);
      throw error;
    }
    if (!recorded) return;
    if (this.#inert) {
      this.note("inert", "STYLE_EVENT_SILENT: signals are recorded but asking is disabled (missing scope reactions:read)");
    }
    // A reaction taken back withdraws the question; removing is never itself a reason to ask.
    if (event.kind === "removed") {
      this.#store.clearAsked(event.channel, event.subjectId, event.messageId, event.emoji);
      return;
    }
    if (event.polarity !== "other") return;
    if (this.#mode !== "ask" || this.#inert) return;
    if (signal.aborted) return;
    const askedAt = this.#store.askedAt(event.channel, event.subjectId);
    if (askedAt !== undefined && this.#now() - Date.parse(askedAt) < ASK_WINDOW_MS) {
      this.#store.markSkipped(event.eventId, ASK_SKIPPED_RATE);
      this.#log("STYLE_ASK_SKIPPED_RATE");
      return;
    }
    try {
      await this.#send(event.channel, STYLE_ASK_TEXT, signal, event.threadTs);
    } catch (error) {
      // The question did not reach anybody, so the scope is not marked as asked: the next reaction
      // may try again. A failure here never touches the delivered reply or the stored signal.
      this.#log(`Style ask failed: ${errorCode(error)}`);
      return;
    }
    this.#store.markAsked(event.eventId, new Date(this.#now()).toISOString());
    this.#log("STYLE_ASK");
  }

  /** One line per cause, once: bounded noise that still says which state the deployment is in. */
  private note(cause: string, line: string): void {
    if (this.#noted.has(cause)) return;
    this.#noted.add(cause);
    this.#log(line);
  }
}
