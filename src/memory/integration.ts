// Memory composition root (MEM-07): the one entry the application uses to wire the verified
// memory modules into the request lifecycle. It constructs the modules, registers their native
// tools, hooks and tasks, and performs the per-request durable steps in the frozen order:
//
//   startup   attach the opened Harness and its root conversation. Memory state is durable and
//             keyed by conversation; there is nothing to re-scan at startup.
//   prepare   an already-admitted requestId is classified (done = replay, unsettled = recovery)
//             and gets no new projection or model call. A new request plans with the pure
//             Context module: establish B, project a working revision into C, or ask the native
//             machinery to compact. A committed projection whose input was never submitted is
//             reused as written, never recomputed over.
//   complete  the finished request is counted once by requestId; at the evaluation point the
//             token-first evaluation may start a native compaction.
//
// Business errors stay `MemoryError`s with the frozen mapping (MEM-01): the request layer turns
// them into `MEMORY_*` application errors, never `AGENT_SESSION_FAILED`. Storage failures are not
// `MemoryError`s and keep the Session failure path. Compaction housekeeping at the boundaries is
// best-effort by design (§8, §11): a failed confirmation is logged and never fails a chat.
//
// Observation carries identifiers, versions, counts, durations and safe error codes only —
// never memory text (design §11).

// Core memory (MemFS) shares this composition entry so the application keeps exactly one memory
// import (the 07-G/08-H boundary checks); the host reaches the factory through `src/memory-fs.ts`.
export { MEMORY_LIMITS } from "./fs/contracts.js";
export { createMemoryFs, type MemoryFs } from "./fs/store.js";
export {
  createDreamingRunner,
  DREAMING_DEFAULTS,
  parseDreamingState,
  type DreamingBehavior,
  type DreamingClock,
  type DreamingConfig,
  type DreamingInput,
  type DreamingLogEvent,
  type DreamingRunRecord,
  type DreamingRunStatus,
  type DreamingState,
  type DreamingRunner,
  type DreamingTurn,
  type DreamingTurnInput,
} from "./dreaming.js";

import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  type Conversation,
  type ConversationId,
  type Cursor,
  type Storage,
  type EntryId,
  type EntryRecord,
  type Extension,
  type Harness,
  type Session,
} from "@earendil-works/pi-durable";
import {
  CYCLE_SNAPSHOT_KIND,
  MemoryError,
  type CycleSnapshot,
  type MemoryBudget,
  type SnapshotFacts,
} from "./contracts.js";
import {
  measureRequest,
  planRequest,
  sameFacts,
  snapshotOfProjection,
} from "./context.js";
import { readWorking } from "./working.js";
import { createWorkingExtension } from "./working-tools.js";
import { createDreamingRunner, type DreamingConfig, type DreamingInput, type DreamingRunner, type DreamingTurn } from "./dreaming.js";
import type { MemoryFs } from "./fs/store.js";
import {
  createCompactionExtension,
  evaluateCompaction,
  nativeCompactionPolicy,
  publishedSnapshot,
  readCompactionTurnCount,
  recordCompletedUserRequest,
} from "./compaction.js";
import { buildActivityDigest, type ActivitySource } from "./activity.js";

export type MemoryIntegrationOptions = {
  /** Host data root; activity and dream state live under it. */
  readonly root: string;
  /** The exact instructions text configured on the conversation (block A, application part). */
  readonly instructions: string;
  readonly model: { readonly provider: string; readonly modelId: string };
  /** The model's context window when the catalog states one; thresholds derive from it. */
  readonly contextWindow?: number;
  readonly budget: MemoryBudget;
  readonly reserveTokens: number;
  readonly timezone: string;
  /**
   * Durable storage access for the dreaming activity window. It identifies conversations the
   * dream pass itself created (request id prefix `dreaming:`) so their entries never feed back
   * into the next run. Late-bound because the composition root is built before the Harness opens.
   */
  readonly storage?: () => Storage;
  /** Identifiers-and-codes-only observation; defaults to a one-line stderr log. */
  readonly log?: (event: MemoryLogEvent) => void;
  /**
   * Background consolidation (dreaming). Present only when core memory exists and the host enabled
   * it; without a memory repository there is nothing for a dream run to write.
   */
  readonly dreaming?: {
    readonly config: DreamingConfig;
    readonly memory: MemoryFs;
    readonly dataDir: string;
    /** One background turn in a worktree, using the host's main model chain. */
    readonly run: DreamingTurn;
  };
};

export type MemoryLogEvent = {
  readonly event: string;
  readonly conversationId?: number;
  readonly requestId?: string;
  readonly runId?: string;
  readonly action?: string;
  readonly code?: string | null;
  readonly turns?: number;
  readonly durationMs?: number;
};

export type PreparedRequest =
  | { readonly kind: "replay" }
  | { readonly kind: "recover" }
  | { readonly kind: "new"; readonly action: string };

const REVISION_PROJECTION_KIND = "personal.context.projection";
/** Window assumed only when the model catalog omits one; production models state theirs. */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/** An error in the shape the request layer surfaces: the frozen application code, nothing else. */
export function memoryAppError(error: MemoryError): Error {
  return Object.assign(new Error(`Memory operation failed: ${error.message}`, { cause: error }), { code: error.appCode });
}

/** True for a memory business error (frozen codes), as opposed to a base/storage failure. */
export function isMemoryError(error: unknown): error is MemoryError {
  return error instanceof MemoryError;
}

export class MemoryIntegration {
  readonly #options: MemoryIntegrationOptions;
  readonly #log: (event: MemoryLogEvent) => void;
  #harness: Harness | undefined;
  #root: Conversation | undefined;
  #rootConversationId: ConversationId | undefined;
  #dreaming: DreamingRunner | undefined;
  #closed = false;

  constructor(options: MemoryIntegrationOptions) {
    this.#options = options;
    this.#log = options.log ?? ((event) => console.error(`Memory ${event.event}: ${JSON.stringify(event)}`));
    if (options.dreaming !== undefined) {
      this.#dreaming = createDreamingRunner({
        config: options.dreaming.config,
        memory: options.dreaming.memory,
        dataDir: options.dreaming.dataDir,
        timezone: options.timezone,
        run: options.dreaming.run,
        input: (cursor) => this.#dreamingInput(cursor),
        log: (event) => this.#log({
          event: event.event,
          ...(event.runId === undefined ? {} : { runId: event.runId }),
          ...(event.action === undefined ? {} : { action: event.action }),
          ...(event.code === undefined ? {} : { code: event.code }),
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        }),
      });
    }
  }

  /** The native compaction policy for the harness settings, derived from the one budget (§10). */
  compactionSettings() {
    return nativeCompactionPolicy(this.#options.budget, this.#options.reserveTokens, this.#options.contextWindow);
  }

  get contextWindow(): number {
    return this.#options.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  }

  /**
   * Extensions for the tool registry, in install order: working tools and the compaction hook.
   * The compaction hook persists through a late-bound host commit — the harness only exists after
   * the registry is installed — and hooks cannot run before `attach`, which the application calls
   * immediately after opening the harness.
   */
  extensions(): Extension[] {
    const commit: Pick<Session, "commit"> = {
      commit: (change, context) => this.#session().commit(change, context),
    };
    return [
      createWorkingExtension(),
      createCompactionExtension({
        commit,
        model: this.#options.model,
        budget: this.#options.budget,
        facts: () => this.currentFacts(),
        onResult: (observation) => {
          this.#log({
            event: "compaction.result",
            conversationId: observation.conversationId,
            action: observation.outcome,
            code: observation.errorCode,
            turns: observation.attempts,
          });
          // A completed compaction is a natural consolidation point. The check only enqueues a run;
          // the hook itself never waits for a model.
          if (observation.outcome === "succeeded" && observation.conversationId === this.#rootConversationId) {
            void this.#dreaming?.compactionCompleted().catch((error: unknown) => {
              this.#log({ event: "dreaming.trigger", action: "failed", code: safeCode(error) });
            });
          }
        },
      }),
    ];
  }

  /** Bind the opened harness and its root conversation. Call once, before any request work. */
  attach(harness: Harness, root: Conversation): void {
    if (this.#harness !== undefined) throw new MemoryError("invalid-input", "Memory integration is already attached");
    this.#harness = harness;
    this.#root = root;
    this.#rootConversationId = root.id;
  }

  /**
   * Arm the nightly schedule once the root conversation is usable. A restart after `DREAMING_AT`
   * catches up the missed night, and the run's evidence needs the attached root.
   */
  startDreaming(): void {
    if (this.#dreaming === undefined) return;
    void this.#dreaming.start().catch((error: unknown) => {
      this.#log({ event: "dreaming.clock", action: "failed", code: safeCode(error) });
    });
  }

  /**
   * The durable steps before a user input is submitted, for the attached root conversation. A thin
   * delegation to `prepareRequestIn`; existing callers keep root-bound meaning.
   */
  async prepareRequest(request: { readonly requestId: string; readonly text: string }, context: Context): Promise<PreparedRequest> {
    return this.prepareRequestIn(this.#conversation(), request, context);
  }

  /**
   * The durable steps before a user input is submitted, for one conversation. Throws a `MEMORY_*`-coded
   * error for a plan-level refusal (the request must not run), and lets storage failures propagate untouched.
   */
  async prepareRequestIn(conversation: Conversation, request: { readonly requestId: string; readonly text: string }, context: Context): Promise<PreparedRequest> {
    try {
      return await this.#prepareRequestIn(conversation, request, context);
    } catch (error) {
      // Every memory business error leaves this module in its mapped application shape, so the
      // request layer can never mistake one for a Session failure (MEM-01 mapping).
      if (error instanceof MemoryError) throw memoryAppError(error);
      throw error;
    }
  }

  async #prepareRequestIn(conversation: Conversation, request: { readonly requestId: string; readonly text: string }, context: Context): Promise<PreparedRequest> {
    this.#assertOpen();
    const started = Date.now();
    const session = this.#session();
    const root = conversation;
    const existing = await session.commit(
      async (tx) => tx.submissionByRequest(root.id, request.requestId),
      context,
    );
    if (existing !== undefined) {
      const kind = existing.status === "done" ? "replay" : "recover";
      this.#log({ event: "memory.prepare", conversationId: root.id, requestId: request.requestId, action: kind, durationMs: Date.now() - started });
      return { kind };
    }

    // A projection committed for this request whose input was never submitted is reused as
    // written (§6): recomputing it could publish different bytes for the same fact.
    const projectionId = projectionRequestId(request.requestId);
    const priorProjection = await session.commit(
      async (tx) => tx.submissionByRequest(root.id, projectionId),
      context,
    );
    if (priorProjection !== undefined && priorProjection.status !== "unanswered") {
      this.#log({ event: "memory.prepare", conversationId: root.id, requestId: request.requestId, action: "reuse-projection", durationMs: Date.now() - started });
      return { kind: "new", action: "reuse-projection" };
    }

    const facts = await this.currentFacts();
    let view = await root.context(context);
    let cycle = scanCycle(view.entries);
    const working = await readWorking(session, root.id, context);
    let compactable = compactableTokens(view, this.#options.budget.recentVerbatimTokens);
    if (cycle.snapshot !== undefined && compactable <= 0 && !sameFacts(cycle.snapshot.facts, facts)) {
      // The inputs B was built from changed and there is nothing to summarize (§14.2 step 6
      // would refuse the request outright). The design's own rule for a change that cannot be
      // carried by a tail revision is to end the cycle explicitly (§6): reset, then let the
      // plan below establish the new B behind it. Durable history and working state are
      // untouched; only the active context restarts. With compactable
      // content the planner's compact/facts path handles the same change without a reset.
      await root.reset(undefined, context);
      view = await root.context(context);
      cycle = scanCycle(view.entries);
      compactable = compactableTokens(view, this.#options.budget.recentVerbatimTokens);
      this.#log({ event: "memory.prepare", conversationId: root.id, requestId: request.requestId, action: "facts-restart" });
    }
    const plan = planRequest({
      budget: this.#options.budget,
      instructionsText: this.#options.instructions,
      snapshot: cycle.snapshot,
      working,
      workingInContext: cycle.workingInContext(working.revision),
      inputTokens: measureRequest([...view.messages, userMessage(request.text)])
        + estimateTextTokens(this.#options.instructions),
      contextWindow: this.contextWindow,
      reserveTokens: this.#options.reserveTokens,
      userTurns: countUserTurns(view.entries),
      compactableTokens: compactable,
      facts,
    });
    if (plan.action.kind === "error") {
      const error = new MemoryError(plan.action.error.code, plan.action.error.message, { detail: plan.action.error.detail });
      this.#log({ event: "memory.prepare", conversationId: root.id, requestId: request.requestId, action: "error", code: error.appCode, durationMs: Date.now() - started });
      throw memoryAppError(error);
    }
    if (plan.action.kind === "project") {
      for (const draft of plan.action.drafts) {
        const submission = await root.submit({ type: "write", entry: draft, requestId: projectionId }, context);
        await submission.status(context);
      }
    } else if (plan.action.kind === "compact") {
      // The native machinery owns placement and recovery; the adapter's hook builds B and the
      // switch is confirmed from durable facts at a later boundary, never from this call.
      await root.compact(undefined, context);
    }
    this.#log({
      event: "memory.prepare", conversationId: root.id, requestId: request.requestId,
      action: plan.action.kind, turns: await readCompactionTurnCount(session, root.id, context),
      durationMs: Date.now() - started,
    });
    return { kind: "new", action: plan.action.kind };
  }

  /**
   * The durable steps after a request completed with an answer, for the attached root conversation.
   * A thin delegation to `afterRequestIn`; existing callers keep root-bound meaning.
   */
  async afterRequest(requestId: string, context: Context): Promise<void> {
    return this.afterRequestIn(this.#conversation(), requestId, context);
  }

  /**
   * The durable steps after a request completed with an answer, for one conversation: count it once,
   * evaluate compaction at the boundary. Counting is idempotent by
   * requestId, so a recovered request that completes now is counted exactly once and a replay
   * is filtered by the caller. Housekeeping failures are logged, never thrown into a finished
   * request; storage failures still propagate.
   */
  async afterRequestIn(conversation: Conversation, requestId: string, context: Context): Promise<void> {
    this.#assertOpen();
    const session = this.#session();
    const root = conversation;
    const started = Date.now();
    let counted: { completedUserTurns: number; shouldEvaluate: boolean } | undefined;
    try {
      counted = await recordCompletedUserRequest(session, root.id, requestId, context, this.#options.budget);
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      this.#log({ event: "memory.count", conversationId: root.id, requestId, action: "failed", code: error.appCode });
    }
    if (counted?.shouldEvaluate === true) {
      const view = await root.context(context);
      const decision = evaluateCompaction({
        inputTokens: measureRequest(view.messages) + estimateTextTokens(this.#options.instructions),
        contextWindow: this.contextWindow,
        reserveTokens: this.#options.reserveTokens,
        budget: this.#options.budget,
        completedUserTurns: counted.completedUserTurns,
        compactableTokens: compactableTokens(view, this.#options.budget.recentVerbatimTokens),
      });
      this.#log({ event: "memory.evaluate", conversationId: root.id, requestId, action: decision.kind, turns: counted.completedUserTurns });
      if (decision.kind !== "none") await root.compact(undefined, context);
    }
    this.#log({ event: "memory.complete", conversationId: root.id, requestId, turns: counted?.completedUserTurns, durationMs: Date.now() - started });
  }

  /**
   * End the current context cycle of the attached root conversation. A thin delegation to
   * `resetConversationIn`; existing callers keep root-bound meaning.
   */
  async resetConversation(context: Context): Promise<void> {
    return this.resetConversationIn(this.#conversation(), context);
  }

  /**
   * End one conversation's current context cycle. The reset itself is admitted by the base; the
   * next request's prepare step establishes the new B behind it (§12.4), so no snapshot is written here.
   */
  async resetConversationIn(conversation: Conversation, context: Context): Promise<void> {
    try {
      this.#assertOpen();
      await conversation.reset(undefined, context);
      this.#log({ event: "memory.reset", conversationId: conversation.id });
    } catch (error) {
      if (error instanceof MemoryError) throw memoryAppError(error);
      throw error;
    }
  }

  /**
   * Stop accepting new memory work. The integration holds no I/O of its own: durable tasks and
   * pending publications are the harness's records and survive its close, ready to resume on
   * the next open (§16.3). Call before closing the harness.
   */
  close(): void {
    this.#closed = true;
    this.#dreaming?.close();
  }

  /** The one-line "memory review due" note, when reminder behavior owes one. */
  reminderLine(): string | undefined {
    return this.#dreaming?.reminderLine();
  }

  /** Resolves when no dream run is active or pending; the host uses it for shutdown and tests. */
  whenDreamingIdle(): Promise<void> {
    return this.#dreaming?.whenIdle() ?? Promise.resolve();
  }

  /**
   * Facts B is built from. The instructions are one: B is rendered to sit behind this exact
   * block A, so an upgraded prompt ends the cycle (§14.2). There is no external memory file:
   * workspace/MEMORY.md was retired (ADR-0004); long-term facts live in the working state this
   * integration manages, whose changes flow through the cycle machinery itself — so there is no
   * memory version B depends on, and `memoryDigest` is honestly
   * `null`. A host that ever loads external memory content into B must supply its digest
   * here and accept cycle invalidation.
   */
  async currentFacts(): Promise<SnapshotFacts> {
    return { instructionsDigest: digestText(this.#options.instructions), memoryDigest: null };
  }

  /**
   * The bounded evidence one dream run receives: the owner's most recent turns in the root
   * conversation, and the activity digest of every owner conversation since the previous applied
   * run. The digest is newest-first bounded and redacted by its own module. Never memoized: a run
   * starts after the trigger and must see the newest facts.
   */
  async #dreamingInput(cursor: { readonly evidenceThrough: EntryId | null }): Promise<DreamingInput> {
    const conversation = this.#conversation();
    const view = await conversation.context(BACKGROUND_CONTEXT);
    const transcript = boundFromEnd(transcriptExcerpt(view.entries, view.contributions), DREAMING_EVIDENCE_TOKENS);
    const { sources } = await this.#activitySources(cursor.evidenceThrough, BACKGROUND_CONTEXT);
    const digest = buildActivityDigest(sources, { timezone: this.#options.timezone });
    return {
      transcript,
      activity: digest.text,
      evidenceThrough: digest.through !== null
        && (cursor.evidenceThrough === null || digest.through > cursor.evidenceThrough)
        ? digest.through
        : cursor.evidenceThrough,
    };
  }

  /**
   * Every entry after `from` in every conversation that is not a dream conversation. Entry ids are
   * global and increasing, so one id is the whole cursor; conversations are scanned independently
   * and the newest entry seen becomes the next cursor. The scan is bounded as a safety valve; the
   * digest's own token cap normally trims long before it.
   */
  async #activitySources(from: EntryId | null, context: Context): Promise<{ readonly sources: ActivitySource[]; readonly through: EntryId | null }> {
    const excluded = await this.#dreamingConversations(context);
    return this.#session().commit(async (tx) => {
      const sources: ActivitySource[] = [];
      let through = from;
      let scanned = 0;
      let conversationCursor: Cursor | undefined;
      do {
        const conversations = await tx.scanConversations({}, ACTIVITY_CONVERSATION_PAGE, conversationCursor);
        for (const record of conversations.items) {
          if (excluded.has(record.id)) continue;
          let entryCursor: Cursor | undefined;
          do {
            const entries = await tx.scanEntries({
              conversationId: record.id,
              ...(from === null ? {} : { minEntryId: (from + 1) as EntryId }),
              order: "ascending",
            }, ACTIVITY_ENTRY_PAGE, entryCursor);
            for (const entry of entries.items) {
              sources.push({ conversationId: record.id, entry });
              if (through === null || entry.id > through) through = entry.id;
              scanned += 1;
              if (scanned >= ACTIVITY_MAX_ENTRIES) return { sources, through };
            }
            entryCursor = entries.next;
          } while (entryCursor !== undefined);
        }
        conversationCursor = conversations.next;
      } while (conversationCursor !== undefined);
      return { sources, through };
    }, context);
  }

  /**
   * Conversations the dream pass itself created, identified by their submission request id. A
   * dream conversation is ownerless and would otherwise look like owner activity, so its entries
   * must never feed the next run. Storage is required because the transaction surface cannot scan
   * submissions.
   */
  async #dreamingConversations(context: Context): Promise<ReadonlySet<ConversationId>> {
    const storage = this.#options.storage?.();
    if (storage === undefined) {
      throw new MemoryError("invalid-input", "Dreaming activity needs durable storage access");
    }
    const excluded = new Set<ConversationId>();
    let cursor: Cursor | undefined;
    let scanned = 0;
    do {
      const page = await storage.scanSubmissions({}, DREAMING_SUBMISSION_PAGE, cursor, context);
      for (const submission of page.items) {
        if (submission.requestId?.startsWith(DREAMING_REQUEST_PREFIX)) excluded.add(submission.conversationId);
      }
      scanned += page.items.length;
      cursor = page.next;
    } while (cursor !== undefined && scanned < DREAMING_SUBMISSION_SCAN_MAX);
    return excluded;
  }

  #session(): Harness {
    if (this.#harness === undefined) throw new MemoryError("invalid-input", "Memory integration is not attached to a harness");
    return this.#harness;
  }

  #conversation(): Conversation {
    if (this.#root === undefined) throw new MemoryError("invalid-input", "Memory integration is not attached to a conversation");
    return this.#root;
  }

  #assertOpen(): void {
    if (this.#closed) throw new MemoryError("cancelled", "Memory integration is closed");
  }
}

/** Construct the composition root; the application owns the returned object's lifecycle. */
export function createMemoryIntegration(options: MemoryIntegrationOptions): MemoryIntegration {
  return new MemoryIntegration(options);
}

/** A committed projection is unfinished application work until its input is admitted. */
export async function hasUnsubmittedMemoryProjection(storage: Storage, conversationId: ConversationId, context: Context): Promise<boolean> {
  const prefix = projectionRequestId("");
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanSubmissions({ conversationId, status: "done" }, 100, cursor, context);
    for (const submission of page.items) {
      if (submission.type !== "write" || !submission.requestId?.startsWith(prefix)) continue;
      const input = await storage.submissionByRequest(conversationId, submission.requestId.slice(prefix.length), context);
      if (input === undefined) return true;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return false;
}

/** The submission key of one request's context projection; stable across its retries. */
export function projectionRequestId(requestId: string): string {
  return `memory:projection:${requestId}`;
}

function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function countUserTurns(entries: readonly { readonly kind: string }[]): number {
  return entries.filter((entry) => entry.kind === "pi.user").length;
}

type CycleScan = {
  readonly snapshot: CycleSnapshot | undefined;
  readonly workingInContext: (revision: number) => boolean;
};

/**
 * The active cycle as the view's own entries state it. The view starts at the head marker, so
 * everything visible here belongs to the active context: a compaction head decodes through the
 * MEM-06 compatibility path (a native summary yields no snapshot and blocks no projection), and
 * the newest application projection after it — boundary or revision — is read from its stored
 * data, never recomputed. `workingInContext` is decided by those recorded projections and the
 * snapshot's own baseline (§14.5 seam note): tool results are deliberately not parsed for it.
 */
function scanCycle(entries: readonly EntryRecord[]): CycleScan {
  let snapshot: CycleSnapshot | undefined;
  let snapshotIndex = -1;
  const projections: { index: number; revision: number }[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === "pi.compaction") {
      const decoded = publishedSnapshot(entry);
      if (decoded !== undefined) {
        snapshot = decoded;
        snapshotIndex = index;
      }
    } else if (entry.kind === CYCLE_SNAPSHOT_KIND) {
      const decoded = snapshotOfProjection(entry.data);
      if (decoded !== undefined) {
        snapshot = decoded;
        snapshotIndex = index;
        projections.push({ index, revision: decoded.baseline.revision });
      }
    } else if (entry.kind === REVISION_PROJECTION_KIND) {
      const data = entry.data as { baseline?: { revision?: unknown } } | undefined;
      if (typeof data?.baseline?.revision === "number") projections.push({ index, revision: data.baseline.revision });
    }
  });
  return {
    snapshot,
    workingInContext: (revision) =>
      (snapshot !== undefined && snapshot.baseline.revision === revision)
      || projections.some((projection) => projection.index >= snapshotIndex && projection.revision === revision),
  };
}

/**
 * Tokens the next compaction could actually replace: the active entries older than the retained
 * verbatim tail. The head marker (block B itself) and application projections are not content to
 * summarize, so they never count as compactable.
 */
function compactableTokens(
  view: { readonly entries: readonly { readonly kind: string }[]; readonly contributions: readonly (readonly Message[])[] },
  recentVerbatimTokens: number,
): number {
  let tail = 0;
  let compactable = 0;
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index]!;
    if (entry.kind === "pi.compaction" || entry.kind === CYCLE_SNAPSHOT_KIND || entry.kind === REVISION_PROJECTION_KIND || entry.kind === "pi.reset") continue;
    const tokens = estimateTextTokens(messageText(view.contributions[index] ?? []));
    if (tail < recentVerbatimTokens) tail += tokens;
    else compactable += tokens;
  }
  return compactable;
}

/** Dreaming evidence bounds: the transcript is capped here, the activity digest by its own module. */
const DREAMING_EVIDENCE_TOKENS = 8_000;
const DREAMING_TRANSCRIPT_TURNS = 20;
const DREAMING_REQUEST_PREFIX = "dreaming:";
const ACTIVITY_ENTRY_PAGE = 200;
const ACTIVITY_CONVERSATION_PAGE = 100;
/** Safety valve; the activity token cap trims the rendered digest long before this. */
const ACTIVITY_MAX_ENTRIES = 20_000;
const DREAMING_SUBMISSION_PAGE = 500;
const DREAMING_SUBMISSION_SCAN_MAX = 200_000;

/**
 * The owner's last turns as plain `role: text` lines, oldest first. A turn ends at a user message;
 * tool traffic is already represented in the assistant text the harness keeps.
 */
function transcriptExcerpt(
  entries: readonly { readonly kind: string }[],
  contributions: readonly (readonly Message[])[],
): string {
  const lines: string[] = [];
  let turns = 0;
  for (let index = entries.length - 1; index >= 0 && turns <= DREAMING_TRANSCRIPT_TURNS; index -= 1) {
    for (const message of contributions[index] ?? []) {
      if (message.role === "user") {
        turns += 1;
        if (turns > DREAMING_TRANSCRIPT_TURNS) break;
      }
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = messageText([message]).trim();
      if (text === "") continue;
      lines.push(`${message.role}: ${text}`);
    }
  }
  lines.reverse();
  return lines.join("\n");
}

/** Keep the newest part of a bounded evidence block, cutting at a line boundary. */
function boundFromEnd(text: string, tokens: number): string {
  if (estimateTextTokens(text) <= tokens) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = estimateTextTokens(`${line}\n`);
    if (used + cost > tokens) break;
    used += cost;
    kept.push(line);
  }
  return kept.reverse().join("\n");
}

function safeCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code.slice(0, 64) : "DREAMING_ERROR";
}

function messageText(messages: readonly Message[]): string {
  return messages.map((message) => {
    if (typeof message.content === "string") return message.content;
    return (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
  }).join("\n");
}
