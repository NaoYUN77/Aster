import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationId } from "@earendil-works/pi-durable";
import { StateError } from "./errors.js";

/**
 * Team Hubs: one conversation per member, so two people never share a context, a memory store or a
 * tool policy. The owner's Hub is the harness root conversation, which already exists; every other
 * member gets a conversation created on first contact and remembered here, keyed by the Slack member
 * id the transport reported — never by anything the model or the member wrote.
 *
 * A follow-up inside one of the bot's threads is a *fork* of the member's Hub, not of the thread:
 * the thread decides who is being answered and where, the Hub decides what the agent already knows.
 */
export type Hub = {
  readonly memberId: string;
  /** The member's own conversation: their history, their preferences, their tool policy. */
  readonly conversationId: ConversationId;
};

/**
 * One thread's fork of a Hub. `rounds` counts the answers that fork has given, deduplicated by
 * request id so a redelivered or recovered request cannot consume the budget twice.
 */
export type Thread = {
  readonly channel: string;
  readonly threadTs: string;
  /** The Hub this thread belongs to. */
  readonly conversationId: ConversationId;
  /** The fork answering in this thread; absent until the first follow-up creates it. */
  readonly fork: ConversationId | undefined;
  readonly rounds: number;
  readonly closed: boolean;
};

/** Answers one thread's fork gives before the host ends it. The owner's Hub is not capped. */
export const MAX_FORK_ROUNDS = 5;

/**
 * The host's own notice, delivered without a model call: once as the closing line of the last
 * answer, and on every later request in that thread instead of running the agent again.
 */
export const FORK_CLOSED_NOTICE = "该问题循环过多，请不要再回复。";

/** A member Hub's daily memory store root; `openDaily` puts the store under `<root>/memory/daily`. */
export function memberMemoryRoot(dataDir: string, memberId: string): string {
  return join(dataDir, "memory", "members", memberDirectory(memberId));
}

/** A member Hub's default working directory. The owner's stays `<dataDir>/workspace`. */
export function memberWorkspace(dataDir: string, memberId: string): string {
  return join(dataDir, "workspace", "members", memberDirectory(memberId));
}

/**
 * Both directories are derived from the member id, not from the conversation that happens to serve
 * it, so a Hub's memory and files stay with the member even if the conversation is ever recreated.
 * A Slack member id is the transport's own identifier; anything else is refused rather than turned
 * into a path component.
 */
function memberDirectory(memberId: string): string {
  if (!/^[UW][A-Z0-9]{6,15}$/.test(memberId)) throw new StateError("Not a Slack member id");
  return memberId;
}

function timestamp(): string {
  return new Date().toISOString();
}

function asConversationId(value: unknown): ConversationId {
  return Number(value) as ConversationId;
}

/**
 * Durable bookkeeping for Hubs and their threads. It stores identifiers and counts only: no message
 * text, no member names, nothing the model produced.
 */
export class HubStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS hubs (
        memberId TEXT PRIMARY KEY,
        conversationId INTEGER NOT NULL UNIQUE,
        adoptedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        channel TEXT NOT NULL,
        threadTs TEXT NOT NULL,
        conversationId INTEGER NOT NULL,
        forkId INTEGER,
        closedAt TEXT,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (channel, threadTs)
      );
      CREATE TABLE IF NOT EXISTS threadRounds (
        channel TEXT NOT NULL,
        threadTs TEXT NOT NULL,
        requestId TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (channel, threadTs, requestId)
      );
    `);
  }

  /** The member's Hub, when one has been created. */
  member(memberId: string): Hub | undefined {
    const row = this.db.prepare("SELECT memberId, conversationId FROM hubs WHERE memberId = ?").get(memberId) as
      | { memberId: string; conversationId: number }
      | undefined;
    if (row === undefined) return undefined;
    return { memberId: row.memberId, conversationId: asConversationId(row.conversationId) };
  }

  /**
   * Records the conversation a member's Hub got. The member id is the transport's identifier, so a
   * data directory belongs to the members it was created for: adopting a *different* conversation for
   * a member that already has one is a programming error, not a migration.
   */
  adopt(memberId: string, conversationId: ConversationId): Hub {
    const existing = this.member(memberId);
    if (existing !== undefined) {
      if (String(existing.conversationId) !== String(conversationId)) {
        throw new StateError("Member already has a Hub conversation; a Hub is not reassigned automatically");
      }
      return existing;
    }
    this.db.prepare("INSERT INTO hubs (memberId, conversationId, adoptedAt) VALUES (?, ?, ?)")
      .run(memberId, Number(conversationId), timestamp());
    return { memberId, conversationId };
  }

  /** The member whose Hub is this conversation, for finding the owner of a fork. */
  memberOf(conversationId: ConversationId): string | undefined {
    const row = this.db.prepare("SELECT memberId FROM hubs WHERE conversationId = ?").get(Number(conversationId)) as
      | { memberId: string }
      | undefined;
    return row?.memberId;
  }

  thread(channel: string, threadTs: string): Thread | undefined {
    const row = this.db.prepare(`SELECT t.channel, t.threadTs, t.conversationId, t.forkId, t.closedAt,
      (SELECT COUNT(*) FROM threadRounds r WHERE r.channel = t.channel AND r.threadTs = t.threadTs) AS rounds
      FROM threads t WHERE t.channel = ? AND t.threadTs = ?`).get(channel, threadTs) as
      | { channel: string; threadTs: string; conversationId: number; forkId: number | null; closedAt: string | null; rounds: number }
      | undefined;
    if (row === undefined) return undefined;
    return {
      channel: row.channel,
      threadTs: row.threadTs,
      conversationId: asConversationId(row.conversationId),
      fork: row.forkId === null ? undefined : asConversationId(row.forkId),
      rounds: row.rounds,
      closed: row.closedAt !== null,
    };
  }

  /**
   * Opens the thread's record with no fork yet. The caller creates the fork, then records it; an
   * interrupted creation leaves an unfinished record, which the next follow-up resumes.
   */
  openThread(channel: string, threadTs: string, conversationId: ConversationId): Thread {
    const existing = this.thread(channel, threadTs);
    if (existing !== undefined) return existing;
    this.db.prepare(`INSERT OR IGNORE INTO threads (channel, threadTs, conversationId, forkId, closedAt, updatedAt)
      VALUES (?, ?, ?, NULL, NULL, ?)`).run(channel, threadTs, Number(conversationId), timestamp());
    return this.thread(channel, threadTs)!;
  }

  /** Records the conversation that answers in this thread. The first fork wins; a retry is a no-op. */
  setFork(channel: string, threadTs: string, fork: ConversationId): void {
    this.db.prepare(`UPDATE threads SET forkId = ?, updatedAt = ? WHERE channel = ? AND threadTs = ?`)
      .run(Number(fork), timestamp(), channel, threadTs);
  }

  /**
   * Counts one answered request against the thread's budget and answers the thread as it now stands.
   * Recording the same request id twice changes nothing, so a replay cannot end a thread early.
   */
  recordRound(channel: string, threadTs: string, requestId: string): Thread {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT OR IGNORE INTO threadRounds (channel, threadTs, requestId, at) VALUES (?, ?, ?, ?)`)
        .run(channel, threadTs, requestId, timestamp());
      this.db.prepare("UPDATE threads SET updatedAt = ? WHERE channel = ? AND threadTs = ?").run(timestamp(), channel, threadTs);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const thread = this.thread(channel, threadTs);
    if (thread === undefined) throw new StateError("Thread record disappeared while counting a round");
    return thread;
  }

  /** Ends the thread's fork: later requests are answered by the notice, not by the agent. */
  closeThread(channel: string, threadTs: string): void {
    this.db.prepare("UPDATE threads SET closedAt = ?, updatedAt = ? WHERE channel = ? AND threadTs = ? AND closedAt IS NULL")
      .run(timestamp(), timestamp(), channel, threadTs);
  }

  close(): void {
    this.db.close();
  }
}
