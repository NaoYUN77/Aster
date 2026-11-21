// Dreaming: background consolidation of core memory, modeled on Letta's dreaming pass.
//
// A run never writes the live memory repository during the model work. It gets its own git
// worktree (ADR-0001), the child edits files there with the ordinary read/write/edit/bash tools,
// the host checks the wiki layout, and only then commits both sides and fast-forwards the live
// branch. A conflict, timeout, rejection or dry run discards the
// worktree; the live directory keeps every byte it had.
//
// The runner is a process-wide singleton by construction (the integration creates exactly one):
// at most one run is active, a trigger during a run coalesces into one pending run, and a
// trigger check only enqueues work — it never waits for a model. State lives in the memory
// repository's gitignored `.aster/dreaming.json`; only an applied run resets the turn counter.
//
// Observation carries run ids, actions, statuses, counts and durations only — never memory text,
// message bodies, diffs or credentials.

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { EntryId } from "@earendil-works/pi-durable";
import { checkMemoryLayout } from "./fs/layout.js";
import type { MemoryFs } from "./fs/store.js";

export const DREAMING_DEFAULTS = {
  enabled: true,
  turns: 20,
  onCompaction: true,
  behavior: "auto-launch",
  dryRun: false,
  timeoutMs: 120_000,
} as const;

export type DreamingBehavior = "auto-launch" | "reminder";

/** The validated host settings; every value is checked even when dreaming is disabled. */
export type DreamingConfig = {
  readonly enabled: boolean;
  readonly turns: number;
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
  readonly commit: string | null;
  /** A stable code such as `timeout`, `conflict`, `layout-invalid`; never model text. */
  readonly reason: string | null;
};

export type DreamingState = {
  readonly version: 1;
  readonly turnsSinceApply: number;
  readonly lastRun: DreamingRunRecord | null;
  readonly lastAppliedCommit: string | null;
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
  readonly turns?: number;
  readonly durationMs?: number;
  /** Layout lint only: issue codes and their count, never memory text. */
  readonly codes?: readonly string[];
  readonly issues?: number;
};

export type DreamingRunnerOptions = {
  readonly config: DreamingConfig;
  readonly memory: MemoryFs;
  /** Root of the host data directory; worktrees live at `<dataDir>/dreaming/worktrees/<runId>`. */
  readonly dataDir: string;
  readonly timezone: string;
  readonly run: DreamingTurn;
  /** Bounded evidence for one run; called only when a run actually starts. */
  readonly input: (cursor: { readonly evidenceThrough: EntryId | null }) => Promise<DreamingInput>;
  readonly log?: (event: DreamingLogEvent) => void;
  /** Test seam; production uses the wall clock. */
  readonly now?: () => Date;
};

export interface DreamingRunner {
  /** Count one completed owner turn; triggers when the threshold is reached. Never awaits a run. */
  observeTurn(): Promise<void>;
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
const BRANCH_PREFIX = "dreaming/";
const COMMIT_AUTHOR = { name: "Aster Memory", email: "memory@aster.local" } as const;
const GIT_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_000;
const FAILURE_BACKOFF_BASE_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 60 * 60_000;
const REMINDER_LINE = "System note: a memory review is due. Consider whether anything from this conversation belongs in MEMORY.md.";

/** The fixed brief for the dream conversation. Evidence arrives in the prompt, never here. */
export const DREAMING_INSTRUCTIONS = `You are Aster's dreaming pass. You are working inside an isolated git worktree of
the owner's core-memory repository, and that worktree is your whole world.
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
Leave every edit uncommitted: never run git commit, checkout, reset or any command that moves HEAD;
the host stages, checks the layout and commits the worktree.
When you are done, reply with one plain line naming what changed; do not use Markdown markup.`;

type Worktree = { readonly path: string; readonly branch: string; readonly runId: string };

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

  constructor(options: DreamingRunnerOptions) {
    this.#options = options;
    this.#log = options.log ?? ((event) => console.error(`Memory ${event.event}: ${JSON.stringify(event)}`));
  }

  async status(): Promise<DreamingState> {
    await this.#load();
    return this.#state;
  }

  async observeTurn(): Promise<void> {
    if (this.#closed || !this.#options.config.enabled) return;
    await this.#load();
    if (this.#options.config.behavior === "reminder") {
      const reminderTurns = this.#state.reminderTurns + 1;
      this.#state = { ...this.#state, reminderTurns };
      await this.#persist();
      if (reminderTurns < this.#options.config.turns) return;
      this.#state = { ...this.#state, reminderTurns: 0 };
      this.#reminderDue = true;
      await this.#persist();
      this.#log({ event: "dreaming.trigger", action: "reminder", turns: 0 });
      return;
    }
    this.#state = { ...this.#state, turnsSinceApply: this.#state.turnsSinceApply + 1 };
    await this.#persist();
    if (this.#state.turnsSinceApply < this.#options.config.turns) return;
    this.#schedule("turns");
  }

  async compactionCompleted(): Promise<void> {
    if (this.#closed || !this.#options.config.enabled || !this.#options.config.onCompaction) return;
    await this.#load();
    if (this.#options.config.behavior === "reminder") {
      // A compaction is an immediate nudge; any partial reminder progress is settled.
      this.#state = { ...this.#state, reminderTurns: 0 };
      this.#reminderDue = true;
      await this.#persist();
      this.#log({ event: "dreaming.trigger", action: "reminder", turns: 0 });
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
    this.#log({ event: "dreaming.trigger", action: reason, turns: this.#state.turnsSinceApply });
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

  // --- one run --------------------------------------------------------------------------------

  async #runOnce(reason: string): Promise<void> {
    const startedAt = this.#now().toISOString();
    const startedMs = this.#now().getTime();
    const config = this.#options.config;
    const adapter = new AbortController();
    // One hard deadline for the whole run: the model turn, every git command and the apply
    // share it, so DREAMING_TIMEOUT_MS is the run's limit rather than each call's.
    const deadline = new AbortController();
    const signal = AbortSignal.any([adapter.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), config.timeoutMs);
    this.#abort = adapter;
    let worktree: Worktree | undefined;
    let applied = false;
    try {
      await this.#load();
      signal.throwIfAborted();
      await this.#options.memory.ensure();
      signal.throwIfAborted();
      const input = await this.#options.input({ evidenceThrough: this.#state.evidenceThrough });
      const turns = this.#state.turnsSinceApply;
      const runId = await this.#newRunId();
      const memoryDir = this.#options.memory.directory;
      const base = (await git(memoryDir, ["rev-parse", "HEAD"], signal)).trim();
      worktree = {
        runId,
        branch: `${BRANCH_PREFIX}${runId}`,
        path: join(this.#options.dataDir, "dreaming", "worktrees", runId),
      };
      await mkdir(dirname(worktree.path), { recursive: true });
      signal.throwIfAborted();
      await rm(worktree.path, { recursive: true, force: true });
      // A crashed earlier process leaves a registered worktree and branch behind; neither may
      // block this run.
      await gitTry(memoryDir, ["worktree", "remove", "--force", worktree.path]);
      await gitTry(memoryDir, ["worktree", "prune"]);
      await gitTry(memoryDir, ["branch", "-D", worktree.branch]);
      await git(memoryDir, ["worktree", "add", "-b", worktree.branch, worktree.path, base], signal);
      this.#log({ event: "dreaming.run.start", runId, action: reason, turns });

      const dreamPrompt = buildDreamPrompt(input, this.#options.timezone);
      await this.#runWithRetry(signal, {
        runId, cwd: worktree.path, instructions: DREAMING_INSTRUCTIONS, prompt: dreamPrompt,
      }, async () => {
        await git(worktree!.path, ["reset", "--hard", base], signal);
        await git(worktree!.path, ["clean", "-fd"], signal);
      });

      // The brief forbids committing, but a model may commit anyway. Rewind to the base without
      // touching the working tree so its edits are staged like any other change, not mistaken for
      // an empty run.
      const dreamHead = (await git(worktree.path, ["rev-parse", "HEAD"], signal)).trim();
      if (dreamHead !== base) await git(worktree.path, ["reset", "--soft", base], signal);
      await git(worktree.path, ["add", "-A"], signal);
      if ((await gitTry(worktree.path, ["diff", "--cached", "--quiet"], signal)).code === 0) {
        throw new DreamDiscard("no-change");
      }
      // The wiki contract: MEMORY.md indexes every note, every index link resolves. A pass that
      // breaks it is not memory worth keeping.
      signal.throwIfAborted();
      const layout = await checkMemoryLayout(worktree.path);
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
        this.#log({ event: "dreaming.run.discarded", runId, action: "dry-run", turns });
        // A dry run is a completed cycle: the counter restarts, so the next trigger again needs a
        // full threshold instead of firing on every following turn.
        await this.#record({ startedAt, status: "dry-run", commit: null, reason: null }, { turnsSinceApply: 0 });
        return;
      }

      // Apply, per ADR-0001: commit the worktree, commit a dirty live tree, rebase the dream
      // commit if live advanced, then fast-forward. Never a forced merge.
      signal.throwIfAborted();
      await git(worktree.path, ["commit", "--no-verify", "-m", commitMessage(runId, turns, this.#now())], signal);
      await this.#options.memory.commitDirty("owner", "pre-dreaming-apply");
      signal.throwIfAborted();
      const liveHead = (await git(memoryDir, ["rev-parse", "HEAD"], signal)).trim();
      if (liveHead !== base) {
        // The live branch advanced while the run worked. Rebase the dream commit onto it so the
        // apply is still a fast-forward; a real conflict is the discard path, never a forced merge.
        const rebase = await gitTry(worktree.path, ["rebase", liveHead], signal);
        if (rebase.code !== 0) {
          await gitTry(worktree.path, ["rebase", "--abort"]);
          throw new DreamDiscard("conflict");
        }
      }
      const merge = await gitTry(memoryDir, ["merge", "--ff-only", worktree.branch], signal);
      if (merge.code !== 0) throw new DreamDiscard("merge-failed");
      const commit = (await git(memoryDir, ["rev-parse", "HEAD"], signal)).trim();
      applied = true;
      // The cursor only moves forward: a stale or simultaneous scan can never rewind it.
      const through = input.evidenceThrough !== null
        && (this.#state.evidenceThrough === null || input.evidenceThrough > this.#state.evidenceThrough)
        ? input.evidenceThrough
        : undefined;
      await this.#record(
        { startedAt, status: "applied", commit, reason: null },
        {
          turnsSinceApply: 0,
          lastAppliedCommit: commit,
          failure: null,
          ...(through === undefined ? {} : { evidenceThrough: through }),
        },
      );
      this.#failureCount = 0;
      this.#backoffUntil = 0;
      this.#log({ event: "dreaming.run.applied", runId, durationMs: this.#now().getTime() - startedMs, turns });
    } catch (error) {
      if (error instanceof DreamDiscard) {
        this.#log({ event: "dreaming.run.discarded", runId: worktree?.runId, action: error.reason, code: error.reason });
        await this.#record({ startedAt, status: "discarded", commit: null, reason: error.reason });
      } else if (this.#closed) {
        // A host shutdown aborted the run; that is a discard, not a model failure to back off from.
        this.#log({ event: "dreaming.run.discarded", runId: worktree?.runId, action: "closed", code: "closed" });
        await this.#record({ startedAt, status: "discarded", commit: null, reason: "closed" });
      } else if (deadline.signal.aborted) {
        this.#log({ event: "dreaming.run.discarded", runId: worktree?.runId, action: "timeout", code: "timeout" });
        await this.#record({ startedAt, status: "discarded", commit: null, reason: "timeout" });
      } else {
        const code = errorCode(error);
        this.#log({ event: "dreaming.run.failed", runId: worktree?.runId, code, durationMs: this.#now().getTime() - startedMs });
        this.#failureCount += 1;
        this.#backoffUntil = this.#now().getTime()
          + Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (this.#failureCount - 1), FAILURE_BACKOFF_MAX_MS);
        await this.#record(
          { startedAt, status: "failed", commit: null, reason: code },
          { failure: { at: this.#now().toISOString(), reason: code } },
        );
      }
    } finally {
      clearTimeout(timer);
      this.#abort = undefined;
      // Cleanup must run even after the deadline fired, so it never uses the timed signal.
      if (worktree !== undefined) await this.#discardWorktree(worktree, applied);
    }
  }

  async #record(
    entry: { startedAt: string; status: DreamingRunStatus; commit: string | null; reason: string | null },
    next?: Partial<Pick<DreamingState, "turnsSinceApply" | "lastAppliedCommit" | "failure" | "evidenceThrough">>,
  ): Promise<void> {
    const endedAt = this.#now().toISOString();
    const lastRun: DreamingRunRecord = {
      startedAt: entry.startedAt,
      endedAt,
      status: entry.status,
      commit: entry.commit,
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

  async #discardWorktree(worktree: Worktree, applied: boolean): Promise<void> {
    await gitTry(this.#options.memory.directory, ["worktree", "remove", "--force", worktree.path]);
    await rm(worktree.path, { recursive: true, force: true });
    // An applied branch is already merged; a discarded one is deleted outright.
    await gitTry(this.#options.memory.directory, ["branch", applied ? "-d" : "-D", worktree.branch]);
  }

  async #newRunId(): Promise<string> {
    const stamp = this.#now().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
    let candidate = stamp;
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const path = join(this.#options.dataDir, "dreaming", "worktrees", candidate);
      const exists = await readFile(join(path, ".git")).then(() => true, () => false);
      if (!exists) return candidate;
      candidate = `${stamp}-${suffix}`;
    }
    return `${stamp}-${this.#now().getTime()}`;
  }

  // --- state ----------------------------------------------------------------------------------

  #now(): Date {
    return this.#options.now?.() ?? new Date();
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
    await this.#cleanupStaleBranches().catch(() => undefined);
  }

  /**
   * Remove branches a crashed process left behind. A `dreaming/*` branch with no registered live
   * worktree can never be applied, so it is deleted; a branch whose worktree still exists (an
   * in-flight or deliberately kept run, or the current branch) is never touched. Cleanup is not
   * on any critical path, so every failure stays silent.
   */
  async #cleanupStaleBranches(): Promise<void> {
    const directory = this.#options.memory.directory;
    await gitTry(directory, ["worktree", "prune"]);
    const listed = await gitTry(directory, ["worktree", "list", "--porcelain"]);
    if (listed.code !== 0) return;
    const live = new Set<string>();
    for (const line of listed.stdout.split("\n")) {
      const match = /^branch refs\/heads\/(.+)$/u.exec(line.trim());
      if (match?.[1] !== undefined) live.add(match[1]);
    }
    const branches = await gitTry(directory, ["for-each-ref", "--format=%(refname:short)", "refs/heads/dreaming"]);
    if (branches.code !== 0) return;
    for (const name of branches.stdout.split("\n").map((line) => line.trim())) {
      if (name === "" || !name.startsWith(BRANCH_PREFIX) || live.has(name)) continue;
      await gitTry(directory, ["branch", "-D", name]);
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
    turnsSinceApply: 0,
    lastRun: null,
    lastAppliedCommit: null,
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
  const turnsSinceApply = integer(record.turnsSinceApply);
  const lastRun = record.lastRun === null ? null : parseRun(record.lastRun);
  const lastAppliedCommit = nullableString(record.lastAppliedCommit);
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
  return { version: STATE_VERSION, turnsSinceApply, lastRun, lastAppliedCommit, failure, evidenceThrough, reminderTurns };
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
    commit: nullableString(record.commit),
    reason: nullableString(record.reason),
  };
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
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("bad string");
  return value;
}

// --- prompts ------------------------------------------------------------------------------------

function buildDreamPrompt(input: DreamingInput, timezone: string): string {
  return `Recent owner turns (oldest first, already bounded):
---
${input.transcript === "" ? "(none)" : input.transcript}
---

Activity since the last applied run (grouped by day; credential-shaped values are redacted):
---
${input.activity === "" ? "(none)" : input.activity}
---

Consolidate this into core memory now. Times are in ${timezone}. Finish every edit, then reply with one line.`;
}

// --- git --------------------------------------------------------------------------------------

function git(directory: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return gitRun(directory, args, signal).then((result) => {
    if (result.code !== 0) {
      const detail = result.stderr.trim().split("\n").at(-1) ?? "";
      throw Object.assign(new Error(`dreaming git failed${detail === "" ? "" : `: ${detail}`}`), { code: "DREAMING_GIT_FAILED" });
    }
    return result.stdout;
  });
}

function gitTry(directory: string, args: readonly string[], signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return gitRun(directory, args, signal);
}

function gitRun(directory: string, args: readonly string[], signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!isAbsolute(directory)) {
    return Promise.resolve({ code: 1, stdout: "", stderr: "memory directory must be absolute" });
  }
  return new Promise((resolvePromise) => {
    execFile("git", ["-C", directory, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      ...(signal === undefined ? {} : { signal }),
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: COMMIT_AUTHOR.name,
        GIT_AUTHOR_EMAIL: COMMIT_AUTHOR.email,
        GIT_COMMITTER_NAME: COMMIT_AUTHOR.name,
        GIT_COMMITTER_EMAIL: COMMIT_AUTHOR.email,
        GIT_TERMINAL_PROMPT: "0",
      },
    }, (error, stdout, stderr) => {
      if (error === null) return resolvePromise({ code: 0, stdout, stderr });
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function commitMessage(runId: string, turns: number, now: Date): string {
  const scope = turns > 0 ? `${turns} owner turn${turns === 1 ? "" : "s"}` : "a background review";
  return `memory: dream run ${runId} over ${scope} by dreaming at ${now.toISOString()}`;
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
