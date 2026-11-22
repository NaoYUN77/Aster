// Dreaming: background consolidation of core memory, modeled on Letta's dreaming pass.
//
// A run never writes live memory during the model work. It gets a private staging copy
// (ADR-0004), the child edits files there with the ordinary read/write/edit/bash tools, the host
// checks the wiki layout, and only then applies the staged changes with a per-file
// compare-and-swap against the tree the run started from. A conflict, timeout, no-change or
// dry run discards the staging copy; live memory keeps every byte it had. Evidence paths that
// name live memory are rewritten to the staging path, so the model is never told where live is.
//
// The runner is a process-wide singleton by construction (the integration creates exactly one):
// at most one run is active, a trigger during a run coalesces into one pending run, and a
// trigger check only enqueues work — it never waits for a model. The nightly schedule
// (`DREAMING_AT`, interpreted in the memory timezone) runs at most once per local date, and a
// process that starts after the time catches up that same day. State lives in the memory
// directory's `.aster/dreaming.json`; snapshots live in `.aster/versions/`.
//
// Observation carries run ids, actions, statuses, counts and durations only — never memory text,
// message bodies, diffs or credentials.

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EntryId } from "@earendil-works/pi-durable";
import { MemoryFsError } from "./fs/contracts.js";
import { checkMemoryLayout } from "./fs/layout.js";
import type { MemoryFs } from "./fs/store.js";
import { diffTrees, scanTree, type TreeManifest } from "./fs/tree.js";

export const DREAMING_DEFAULTS = {
  enabled: true,
  at: "04:00",
  onCompaction: true,
  behavior: "auto-launch",
  dryRun: false,
  timeoutMs: 120_000,
} as const;

export type DreamingBehavior = "auto-launch" | "reminder";

/** The validated host settings; every value is checked even when dreaming is disabled. */
export type DreamingConfig = {
  readonly enabled: boolean;
  /** Local wall-clock trigger, `HH:MM` on the 24-hour clock, in the memory timezone. */
  readonly at: string;
  readonly onCompaction: boolean;
  readonly behavior: DreamingBehavior;
  readonly dryRun: boolean;
  readonly timeoutMs: number;
};

/** One background turn handed to the host: it runs in `cwd` with the main model and returns text. */
export type DreamingTurnInput = {
  readonly runId: string;
  readonly cwd: string;
  readonly instructions: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
};

export type DreamingTurn = (input: DreamingTurnInput) => Promise<string>;

/** What the host supplies as the run's evidence, already bounded by tokens. */
export type DreamingInput = {
  /** The root conversation's most recent owner turns, oldest first. */
  readonly transcript: string;
  /** Activity from every owner conversation since the last applied run, grouped by day. */
  readonly activity: string;
  /** Newest entry id the activity covers; advanced only by an applied run. */
  readonly evidenceThrough: EntryId | null;
};

export type DreamingRunStatus = "applied" | "dry-run" | "discarded" | "failed" | "no-change";

export type DreamingRunRecord = {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly status: DreamingRunStatus;
  /** Snapshot taken immediately before the apply; the undo point. Null unless applied. */
  readonly snapshot: string | null;
  /** A stable code such as `timeout`, `conflict`, `layout-invalid`; never model text. */
  readonly reason: string | null;
};

export type DreamingState = {
  readonly version: 1;
  /** Local date (`YYYY-MM-DD`) whose nightly trigger already fired; null before the first one. */
  readonly lastNightlyDate: string | null;
  readonly lastRun: DreamingRunRecord | null;
  /** Snapshot id of the newest applied run's undo point. */
  readonly lastAppliedSnapshot: string | null;
  readonly failure: { readonly at: string; readonly reason: string } | null;
  /** Newest durable entry id a run has consumed; advanced only by an applied run. */
  readonly evidenceThrough: EntryId | null;
  /** Completed turns toward the next reminder; persisted so a restart does not lose progress. */
  readonly reminderTurns: number;
};

export type DreamingLogEvent = {
  readonly event: string;
  readonly runId?: string;
  readonly action?: string;
  readonly status?: string;
  readonly code?: string;
  readonly durationMs?: number;
  /** Layout lint only: issue codes and their count, never memory text. */
  readonly codes?: readonly string[];
  readonly issues?: number;
};

export type DreamingRunnerOptions = {
  readonly config: DreamingConfig;
  readonly memory: MemoryFs;
  /** Root of the host data directory; staging copies live at `<dataDir>/dreaming/staging/<runId>`. */
  readonly dataDir: string;
  readonly timezone: string;
  readonly run: DreamingTurn;
  /** Bounded evidence for one run; called only when a run actually starts. */
  readonly input: (cursor: { readonly evidenceThrough: EntryId | null }) => Promise<DreamingInput>;
  readonly log?: (event: DreamingLogEvent) => void;
  /** Wall clock and timers; tests inject a fake so the nightly schedule is deterministic. */
  readonly clock?: DreamingClock;
};

export type DreamingTimerHandle = unknown;

export type DreamingClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): DreamingTimerHandle;
  clearTimeout(handle: DreamingTimerHandle): void;
};

export interface DreamingRunner {
  /**
   * Load state and arm the nightly schedule. A process that starts after `DREAMING_AT` triggers
   * the missed night once (same local date never runs twice). Never awaits a run.
   */
  start(): Promise<void>;
  /** A compaction completed; triggers immediately when `DREAMING_ON_COMPACTION=1`. */
  compactionCompleted(): Promise<void>;
  /** Consume the one-line reminder, when `DREAMING_BEHAVIOR=reminder` made one due. */
  reminderLine(): string | undefined;
  /** Resolves when no run is active and no coalesced run is pending. */
  whenIdle(): Promise<void>;
  status(): Promise<DreamingState>;
  /** Stop accepting triggers and abort the active run. */
  close(): void;
}

const STATE_VERSION = 1;
const STATE_FILE = "dreaming.json";
const STATE_DIR = ".aster";
const RETRY_DELAY_MS = 1_000;
const FAILURE_BACKOFF_BASE_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 60 * 60_000;
const REMINDER_LINE = "System note: a memory review is due. Consider whether anything from this conversation belongs in MEMORY.md.";
const AT_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/u;
const DAY_MS = 24 * 60 * 60_000;

const SYSTEM_CLOCK: DreamingClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    // A nightly timer is background work: it must never keep the process alive by itself.
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** The fixed brief for the dream conversation. Evidence arrives in the prompt, never here. */
export const DREAMING_INSTRUCTIONS = `You are Aster's dreaming pass. You are working inside a private staging copy of the owner's
core-memory directory, and that directory is your whole world. Paths in the evidence below that
named live memory have been rewritten to this copy. Never read, write or remove anything outside
it, and never copy files into or out of it.
Memory has three layers, and you maintain all of them.
Layer one is the evidence in the prompt below: the owner's recent turns, then the activity digest
of what was actually said and done across owner conversations, including tool calls, results and
errors, grouped by day.
Layer two is the notes: one Markdown file per topic, read on demand. You decide how many notes
exist, what each covers and how each is structured. Write dense, abstracted facts, never quotes
or a replay of a conversation. Merge and rewrite notes instead of appending; split a note when it
stops covering one topic; delete a note the evidence shows is obsolete.
Layer three is MEMORY.md, the only file injected into every future turn. It contains exactly two
sections and nothing else:
- "## Core": the few facts Aster must know without reading anything, one short line each, such as
  a standing constraint, the owner's name and language, or a hard preference.
- "## Index": one line per note, written as a Markdown link plus a short hint, for example
  "- [Deploy host](notes/deploy-host.md) — hostname, paths, restart command". Every note must be
  linked here, and every link must point to a note that exists.
Promote a fact into "## Core" when it recurs across turns or the owner says it must always be
known; everything else stays in a note. When evidence contradicts a Core fact, take it out of
Core: correct it into a note, or delete it when it was never true. What the owner states
explicitly overrides anything stored, so record the correction rather than the old belief.
Only record what the supplied evidence supports: every fact must trace to an owner statement, a
tool call and its result, or an error. Never invent events, never store credentials, tokens,
passwords or keys.
Leave every edit in the staging copy. The host compares it with live memory, checks the wiki
layout and applies only what you changed; it owns snapshots and rollback. Do not run git.
When you are done, reply with one plain line naming what changed; do not use Markdown markup.`;

type Staging = { readonly path: string; readonly runId: string };

class DreamDiscard extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "DreamDiscard";
    this.reason = reason;
  }
}

export function createDreamingRunner(options: DreamingRunnerOptions): DreamingRunner {
  return new Runner(options);
}

class Runner implements DreamingRunner {
  readonly #options: DreamingRunnerOptions;
  readonly #log: (event: DreamingLogEvent) => void;
  readonly #clock: DreamingClock;
  #state: DreamingState = emptyState();
  #ready: Promise<void> | undefined;
  #writeChain: Promise<unknown> = Promise.resolve();
  #running = false;
  #pending = false;
  #closed = false;
  #abort: AbortController | undefined;
  #idleWaiters: Array<() => void> = [];
  #failureCount = 0;
  #backoffUntil = 0;
  #reminderDue = false;
  #started = false;
  #timer: DreamingTimerHandle | undefined;

  constructor(options: DreamingRunnerOptions) {
    this.#options = options;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#log = options.log ?? ((event) => console.error(`Memory ${event.event}: ${JSON.stringify(event)}`));
  }

  async status(): Promise<DreamingState> {
    await this.#load();
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#closed || !this.#options.config.enabled || this.#started) return;
    await this.#load();
    if (this.#closed) return;
    this.#started = true;
    await this.#checkNightly();
    this.#arm();
  }

  async compactionCompleted(): Promise<void> {
    if (this.#closed || !this.#options.config.enabled || !this.#options.config.onCompaction) return;
    await this.#load();
    if (this.#options.config.behavior === "reminder") {
      // A compaction is an immediate nudge; it never launches a background run.
      this.#reminderDue = true;
      this.#log({ event: "dreaming.trigger", action: "reminder" });
      return;
    }
    this.#schedule("compaction");
  }

  reminderLine(): string | undefined {
    if (!this.#reminderDue) return undefined;
    this.#reminderDue = false;
    return REMINDER_LINE;
  }

  whenIdle(): Promise<void> {
    if (!this.#running && !this.#pending) return Promise.resolve();
    return new Promise((resolvePromise) => this.#idleWaiters.push(resolvePromise));
  }

  close(): void {
    this.#closed = true;
    this.#pending = false;
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#abort?.abort();
    this.#settleIdle();
  }

  // --- scheduling -----------------------------------------------------------------------------

  #schedule(reason: string): void {
    if (this.#closed || !this.#options.config.enabled) return;
    const now = this.#now().getTime();
    if (now < this.#backoffUntil) {
      this.#log({ event: "dreaming.trigger", action: reason, code: "backoff" });
      return;
    }
    this.#log({ event: "dreaming.trigger", action: reason });
    if (this.#running) {
      // One pending slot, never a queue: any number of triggers during a run coalesce.
      this.#pending = true;
      return;
    }
    this.#start(reason);
  }

  #start(reason: string): void {
    this.#running = true;
    this.#pending = false;
    void this.#runOnce(reason)
      .catch(() => undefined)
      .finally(() => {
        this.#running = false;
        if (this.#pending && !this.#closed) {
          this.#pending = false;
          this.#start("pending");
          return;
        }
        this.#settleIdle();
      });
  }

  #settleIdle(): void {
    if (this.#running || this.#pending) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  // --- nightly schedule -----------------------------------------------------------------------

  /**
   * Fire the night once when the process is already past `DREAMING_AT` and that local date has
   * not run yet. A restart therefore catches up the same day; a fresh process before the time
   * simply arms the timer.
   */
  async #checkNightly(): Promise<void> {
    if (this.#closed || !this.#options.config.enabled) return;
    const now = this.#clock.now();
    const date = localDate(now, this.#options.timezone);
    if (this.#state.lastNightlyDate === date) return;
    const parts = localParts(now, this.#options.timezone);
    const [hour, minute] = parseAt(this.#options.config.at);
    if (parts.hour * 60 + parts.minute < hour * 60 + minute) return;
    // Claim the date before scheduling: a day runs at most once, whatever the run's outcome.
    this.#state = { ...this.#state, lastNightlyDate: date };
    await this.#persist();
    if (this.#options.config.behavior === "reminder") {
      this.#reminderDue = true;
      this.#log({ event: "dreaming.trigger", action: "reminder" });
      return;
    }
    this.#schedule("nightly");
  }

  /** Arm one timer for the next local `HH:MM`; every firing re-checks the date and re-arms. */
  #arm(): void {
    if (this.#closed || !this.#started || !this.#options.config.enabled) return;
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    const now = this.#clock.now();
    const delay = Math.max(0, nextOccurrence(now, this.#options.timezone, this.#options.config.at) - now);
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      void this.#onTimer().catch((error: unknown) => {
        this.#log({ event: "dreaming.clock", code: errorCode(error) });
      });
    }, delay);
  }

  async #onTimer(): Promise<void> {
    if (this.#closed || !this.#options.config.enabled) return;
    try {
      await this.#load();
      await this.#checkNightly();
    } finally {
      this.#arm();
    }
  }

  // --- one run --------------------------------------------------------------------------------

  async #runOnce(reason: string): Promise<void> {
    const startedAt = this.#now().toISOString();
    const startedMs = this.#now().getTime();
    const config = this.#options.config;
    const adapter = new AbortController();
    // One hard deadline for the whole run: the model turn, every file operation and the apply
    // share it, so DREAMING_TIMEOUT_MS is the run's limit rather than each call's.
    const deadline = new AbortController();
    const signal = AbortSignal.any([adapter.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), config.timeoutMs);
    this.#abort = adapter;
    let staging: Staging | undefined;
    let applied = false;
    try {
      await this.#load();
      signal.throwIfAborted();
      await this.#options.memory.ensure();
      signal.throwIfAborted();
      const input = await this.#options.input({ evidenceThrough: this.#state.evidenceThrough });
      const runId = await this.#newRunId();
      staging = { runId, path: join(this.#options.dataDir, "dreaming", "staging", runId) };
      // Snapshot live once, then build the staging copy from that snapshot: the manifest the run
      // is judged against is exactly what the model can see.
      const snapshot = await this.#options.memory.snapshot("dreaming", "pre-run");
      const preRun = snapshot.id;
      const base = await this.#options.memory.materialize(preRun, staging.path);
      const revision = this.#options.memory.revision();
      this.#log({ event: "dreaming.run.start", runId, action: reason });

      const dreamPrompt = buildDreamPrompt(input, this.#options.timezone, {
        from: this.#options.memory.directory,
        to: staging.path,
      });
      await this.#runWithRetry(signal, {
        runId, cwd: staging.path, instructions: DREAMING_INSTRUCTIONS, prompt: dreamPrompt,
      }, async () => {
        await this.#options.memory.materialize(preRun, staging!.path);
      });

      const staged = await scanTree(staging.path);
      if (diffTrees(base, staged).length === 0) throw new DreamDiscard("no-change");
      // The wiki contract: MEMORY.md indexes every note, every index link resolves. A pass that
      // breaks it is not memory worth keeping.
      signal.throwIfAborted();
      const layout = await checkMemoryLayout(staging.path);
      if (layout.length > 0) {
        this.#log({
          event: "dreaming.run.layout",
          runId,
          codes: [...new Set(layout.map((issue) => issue.code))],
          issues: layout.length,
        });
        throw new DreamDiscard("layout-invalid");
      }
      if (config.dryRun) {
        this.#log({ event: "dreaming.run.discarded", runId, action: "dry-run" });
        // A dry run is a completed night: the nightly date was already claimed when it triggered,
        // so it never re-fires the same day.
        await this.#record({ startedAt, status: "dry-run", snapshot: null, reason: null });
        return;
      }

      // The dream may only touch staging. Live changing while the model worked is fine when the
      // host itself took a turn-boundary snapshot (the revision moved); with no such snapshot it
      // is the run leaking into live, so put live back and keep the leaked bytes as a snapshot.
      signal.throwIfAborted();
      const liveNow = await scanTree(this.#options.memory.directory);
      const drift = diffTrees(base, liveNow);
      if (drift.length > 0 && this.#options.memory.revision() === revision) {
        await this.#options.memory.restore(preRun);
        this.#log({ event: "dreaming.run.live", runId, issues: drift.length });
        throw new DreamDiscard("live-modified");
      }

      // Apply with a per-file compare-and-swap: every staged change must still match the live
      // file the run started from. The pre-apply snapshot is the undo point.
      signal.throwIfAborted();
      const apply = await this.#options.memory.applyStaging(staging.path, base, {
        actor: "dreaming",
        reason: `pre-dreaming-apply ${runId}`,
      }).catch((error: unknown) => {
        if (error instanceof MemoryFsError && error.code === "conflict") throw new DreamDiscard("conflict");
        throw error;
      });
      if (apply === null) throw new DreamDiscard("no-change");
      applied = true;
      // The cursor only moves forward: a stale or simultaneous scan can never rewind it.
      const through = input.evidenceThrough !== null
        && (this.#state.evidenceThrough === null || input.evidenceThrough > this.#state.evidenceThrough)
        ? input.evidenceThrough
        : undefined;
      await this.#record(
        { startedAt, status: "applied", snapshot: apply.snapshot, reason: null },
        {
          lastAppliedSnapshot: apply.snapshot,
          failure: null,
          ...(through === undefined ? {} : { evidenceThrough: through }),
        },
      );
      this.#failureCount = 0;
      this.#backoffUntil = 0;
      this.#log({ event: "dreaming.run.applied", runId, durationMs: this.#now().getTime() - startedMs });
    } catch (error) {
      if (error instanceof DreamDiscard) {
        this.#log({ event: "dreaming.run.discarded", runId: staging?.runId, action: error.reason, code: error.reason });
        await this.#record({ startedAt, status: "discarded", snapshot: null, reason: error.reason });
      } else if (this.#closed) {
        // A host shutdown aborted the run; that is a discard, not a model failure to back off from.
        this.#log({ event: "dreaming.run.discarded", runId: staging?.runId, action: "closed", code: "closed" });
        await this.#record({ startedAt, status: "discarded", snapshot: null, reason: "closed" });
      } else if (deadline.signal.aborted) {
        this.#log({ event: "dreaming.run.discarded", runId: staging?.runId, action: "timeout", code: "timeout" });
        await this.#record({ startedAt, status: "discarded", snapshot: null, reason: "timeout" });
      } else {
        const code = errorCode(error);
        this.#log({ event: "dreaming.run.failed", runId: staging?.runId, code, durationMs: this.#now().getTime() - startedMs });
        this.#failureCount += 1;
        this.#backoffUntil = this.#now().getTime()
          + Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (this.#failureCount - 1), FAILURE_BACKOFF_MAX_MS);
        await this.#record(
          { startedAt, status: "failed", snapshot: null, reason: code },
          { failure: { at: this.#now().toISOString(), reason: code } },
        );
      }
    } finally {
      clearTimeout(timer);
      this.#abort = undefined;
      // Cleanup must run even after the deadline fired, so it never uses the timed signal.
      if (staging !== undefined) await this.#discardStaging(staging);
    }
  }

  async #record(
    entry: { startedAt: string; status: DreamingRunStatus; snapshot: string | null; reason: string | null },
    next?: Partial<Pick<DreamingState, "lastAppliedSnapshot" | "failure" | "evidenceThrough" | "lastNightlyDate">>,
  ): Promise<void> {
    const endedAt = this.#now().toISOString();
    const lastRun: DreamingRunRecord = {
      startedAt: entry.startedAt,
      endedAt,
      status: entry.status,
      snapshot: entry.snapshot,
      reason: entry.reason,
    };
    this.#state = { ...this.#state, ...next, lastRun };
    await this.#persist();
  }

  async #runWithRetry(signal: AbortSignal, input: Omit<DreamingTurnInput, "signal">, reset: () => Promise<void>): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#options.run({ ...input, signal });
      } catch (error) {
        if (signal.aborted || attempt >= 2) throw error;
        // A transient model failure earns exactly one retry, from a clean worktree.
        this.#log({ event: "dreaming.run.start", runId: input.runId, action: "retry" });
        await reset();
        await delay(RETRY_DELAY_MS, signal);
      }
    }
  }

  async #discardStaging(staging: Staging): Promise<void> {
    await rm(staging.path, { recursive: true, force: true });
  }

  async #newRunId(): Promise<string> {
    const stamp = this.#now().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
    let candidate = stamp;
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const path = join(this.#options.dataDir, "dreaming", "staging", candidate);
      const exists = await readdir(path).then(() => true, () => false);
      if (!exists) return candidate;
      candidate = `${stamp}-${suffix}`;
    }
    return `${stamp}-${this.#now().getTime()}`;
  }

  // --- state ----------------------------------------------------------------------------------

  #now(): Date {
    return new Date(this.#clock.now());
  }

  async #load(): Promise<void> {
    this.#ready ??= this.#loadInner();
    return this.#ready;
  }

  async #loadInner(): Promise<void> {
    const path = this.#statePath();
    try {
      const text = await readFile(path, "utf8");
      try {
        const parsed: unknown = JSON.parse(text);
        this.#state = parseDreamingState(parsed);
      } catch {
        // Never guess at a damaged state file; start clean and let the operator inspect the old one.
        this.#log({ event: "dreaming.state.corrupt" });
        this.#state = emptyState();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.#cleanupStaleStaging().catch(() => undefined);
  }

  /**
   * Remove staging copies a crashed process left behind. A fresh process owns no run, so every
   * directory here is garbage; a live process empties its own copy in `finally`. Cleanup is not
   * on any critical path, so every failure stays silent.
   */
  async #cleanupStaleStaging(): Promise<void> {
    const directory = join(this.#options.dataDir, "dreaming", "staging");
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names) {
      if (name.startsWith(".")) continue;
      await rm(join(directory, name), { recursive: true, force: true });
    }
  }

  #persist(): Promise<void> {
    const body = `${JSON.stringify(this.#state, null, 2)}\n`;
    const run = this.#writeChain.then(async () => {
      const directory = join(this.#options.memory.directory, STATE_DIR);
      const path = this.#statePath();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, path);
    });
    this.#writeChain = run.catch(() => undefined);
    return run;
  }

  #statePath(): string {
    return join(this.#options.memory.directory, STATE_DIR, STATE_FILE);
  }
}

function emptyState(): DreamingState {
  return {
    version: STATE_VERSION,
    lastNightlyDate: null,
    lastRun: null,
    lastAppliedSnapshot: null,
    failure: null,
    evidenceThrough: null,
    reminderTurns: 0,
  };
}

/**
 * Validate a host-owned state document. Unknown extra fields are dropped, so a damaged or
 * hand-edited file can never smuggle arbitrary content into the status view.
 */
export function parseDreamingState(value: unknown): DreamingState {
  if (typeof value !== "object" || value === null) throw new Error("not an object");
  const record = value as Record<string, unknown>;
  if (record.version !== STATE_VERSION) throw new Error("unknown version");
  // State files written before the nightly schedule simply have no date yet; the old turn
  // counters are ignored on read and never written again.
  const lastNightlyDate = record.lastNightlyDate === undefined || record.lastNightlyDate === null
    ? null
    : localDateString(record.lastNightlyDate);
  const lastRun = record.lastRun === null ? null : parseRun(record.lastRun);
  // A state file from the git era named the applied commit; it migrates to the snapshot id it now
  // records, so an upgrade does not lose the undo pointer.
  const lastAppliedSnapshot = nullableString(record.lastAppliedSnapshot ?? record.lastAppliedCommit);
  const failure = record.failure === null
    ? null
    : (() => {
        if (typeof record.failure !== "object" || record.failure === null) throw new Error("bad failure");
        const item = record.failure as Record<string, unknown>;
        return { at: requiredString(item.at), reason: requiredString(item.reason) };
      })();
  // `evidenceThrough` is the entry-id cursor. A state file written by the daily-archive era
  // carried a date string in `archiveThrough` instead; it is deliberately dropped so the next
  // run starts from the beginning of durable history exactly once.
  const evidenceThrough = nullableEntryId(record.evidenceThrough);
  // A state file written before reminder behavior existed simply has no counter yet.
  const reminderTurns = record.reminderTurns === undefined ? 0 : integer(record.reminderTurns);
  return { version: STATE_VERSION, lastNightlyDate, lastRun, lastAppliedSnapshot, failure, evidenceThrough, reminderTurns };
}

function parseRun(value: unknown): DreamingRunRecord {
  if (typeof value !== "object" || value === null) throw new Error("bad run");
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "applied" && status !== "dry-run" && status !== "discarded" && status !== "failed" && status !== "no-change") {
    throw new Error("bad status");
  }
  return {
    startedAt: requiredString(record.startedAt),
    endedAt: requiredString(record.endedAt),
    status,
    snapshot: nullableString(record.snapshot ?? record.commit),
    reason: nullableString(record.reason),
  };
}

function localDateString(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("bad date");
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("bad integer");
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("bad string");
  return value;
}

function nullableEntryId(value: unknown): EntryId | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("bad entry id");
  return value as EntryId;
}

function nullableString(value: unknown): string | null {
  // `undefined` is a missing key: a state file written before the field existed, or a `??`
  // fallback whose left side was null. It parses as null; anything else non-string is damage.
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("bad string");
  return value;
}


// --- timezone ------------------------------------------------------------------------------------

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = FORMATTERS.get(timezone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    FORMATTERS.set(timezone, cached);
  }
  return cached;
}

type LocalParts = { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number };

/** The wall clock of `timezone` at `instantMs`; the memory timezone is validated at startup. */
function localParts(instantMs: number, timezone: string): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
  };
}

function localDate(instantMs: number, timezone: string): string {
  const parts = localParts(instantMs, timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function parseAt(at: string): [number, number] {
  if (!AT_SHAPE.test(at)) throw new Error(`invalid dreaming time: ${at}`);
  const [hour, minute] = at.split(":").map(Number);
  return [hour!, minute!];
}

/**
 * The next instant whose wall clock in `timezone` reads `HH:MM`, strictly after `nowMs`. Scanning
 * whole minutes keeps DST changes and half-hour offsets honest without a timezone library; the
 * search is bounded to 26 hours because a valid `HH:MM` occurs at least once per local day.
 */
function nextOccurrence(nowMs: number, timezone: string, at: string): number {
  const [hour, minute] = parseAt(at);
  let candidate = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
  for (let step = 0; step <= 26 * 60; step += 1, candidate += 60_000) {
    const parts = localParts(candidate, timezone);
    if (parts.hour === hour && parts.minute === minute) return candidate;
  }
  // The loop only exhausts if the formatter cannot represent the zone; configuration validated it.
  throw new Error(`cannot schedule ${at} in ${timezone}`);
}

// --- prompts ------------------------------------------------------------------------------------

function buildDreamPrompt(
  input: DreamingInput,
  timezone: string,
  roots?: { readonly from: string; readonly to: string },
): string {
  const rewrite = (value: string): string =>
    roots === undefined || roots.from === "" ? value : value.split(roots.from).join(roots.to);
  return `Recent owner turns (oldest first, already bounded):
---
${input.transcript === "" ? "(none)" : rewrite(input.transcript)}
---

Activity since the last applied run (grouped by day; credential-shaped values are redacted):
---
${input.activity === "" ? "(none)" : rewrite(input.activity)}
---

Consolidate this into core memory now. Times are in ${timezone}. Finish every edit, then reply with one line.`;
}

// --- small helpers ----------------------------------------------------------------------------

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code.slice(0, 64);
  return error instanceof Error && error.name === "AbortError" ? "ABORTED" : "DREAMING_FAILED";
}

function abortError(signal: AbortSignal): Error {
  const error = new Error("Dreaming turn was aborted");
  error.name = "AbortError";
  return Object.assign(error, { cause: signal.reason });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
