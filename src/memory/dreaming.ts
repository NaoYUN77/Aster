// Dreaming: background consolidation of core memory, modeled on Letta's dreaming pass.
//
// A run never writes the live memory repository during the model work. It gets its own git
// worktree (ADR-0001), the child edits files there with the ordinary read/write/edit/bash tools,
// an optional review pass audits the staged diff, and only then does the host commit both sides
// and fast-forward the live branch. A conflict, timeout, rejection or dry run discards the
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
import type { MemoryFs } from "./fs/store.js";

export const DREAMING_DEFAULTS = {
  enabled: true,
  turns: 20,
  onCompaction: true,
  behavior: "auto-launch",
  review: true,
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
  readonly review: boolean;
  readonly dryRun: boolean;
  readonly timeoutMs: number;
};

export type DreamingTurnRole = "dream" | "review";

/** One background turn handed to the host: it runs in `cwd` with the main model and returns text. */
export type DreamingTurnInput = {
  readonly runId: string;
  readonly role: DreamingTurnRole;
  readonly cwd: string;
  readonly instructions: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
};

export type DreamingTurn = (input: DreamingTurnInput) => Promise<string>;

/** What the host supplies as the run's evidence, already bounded by tokens. */
export type DreamingInput = {
  readonly transcript: string;
  readonly archive: string;
  readonly archiveThrough: string | null;
};

export type DreamingRunStatus = "applied" | "dry-run" | "discarded" | "failed" | "no-change";

export type DreamingRunRecord = {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly status: DreamingRunStatus;
  readonly commit: string | null;
  /** A stable code such as `timeout`, `conflict`, `review-rejected`; never model text. */
  readonly reason: string | null;
};

export type DreamingState = {
  readonly version: 1;
  readonly turnsSinceApply: number;
  readonly lastRun: DreamingRunRecord | null;
  readonly lastAppliedCommit: string | null;
  readonly failure: { readonly at: string; readonly reason: string } | null;
  /** Newest daily-archive date a run has consumed; advanced only by an applied run. */
  readonly archiveThrough: string | null;
};

export type DreamingLogEvent = {
  readonly event: string;
  readonly runId?: string;
  readonly action?: string;
  readonly status?: string;
  readonly code?: string;
  readonly turns?: number;
  readonly durationMs?: number;
};

export type DreamingRunnerOptions = {
  readonly config: DreamingConfig;
  readonly memory: MemoryFs;
  /** Root of the host data directory; worktrees live at `<dataDir>/dreaming/worktrees/<runId>`. */
  readonly dataDir: string;
  readonly timezone: string;
  readonly run: DreamingTurn;
  /** Bounded evidence for one run; called only when a run actually starts. */
  readonly input: (cursor: { readonly archiveThrough: string | null }) => Promise<DreamingInput>;
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
const DIFF_MAX_CHARS = 24_000;
const RETRY_DELAY_MS = 1_000;
const FAILURE_BACKOFF_BASE_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 60 * 60_000;
const REMINDER_LINE = "System note: a memory review is due. Consider whether anything from this conversation belongs in MEMORY.md.";

/** The fixed brief for the dream conversation. Evidence arrives in the prompt, never here. */
export const DREAMING_INSTRUCTIONS = `You are Aster's dreaming pass. You are working inside an isolated git worktree of
the owner's core-memory repository, and that worktree is your whole world.
Use read, write, edit and bash to update the memory files. MEMORY.md is the file that is injected
into every future turn: keep persona, the owner's profile, standing goals and constraints there,
organized under headings, and keep it concise. Other files are read on demand; keep them factual.
Only record what the supplied evidence supports. Never invent events, never store credentials,
tokens, passwords or keys. Prefer correcting and merging existing notes over appending duplicates.
Delete notes the evidence shows are obsolete. When you are done, reply with one plain line naming
what changed; do not use Markdown markup.`;

/** The fixed brief for the review conversation. Its answer is parsed, never shown. */
export const REVIEW_INSTRUCTIONS = `You audit a proposed update to an owner's core memory before it is applied.
You receive the staged diff of an isolated worktree and the transcript the dream pass was given.
Check that every change is supported by the evidence, that nothing durable was dropped by mistake,
and that no credential, token, password or key appears in the diff.
Answer with exactly one JSON object and nothing else:
{"verdict":"apply"|"reject","reason":"a short code-like phrase","revert":["path",...]}
Use "revert" to drop individual files that should not change; use "reject" to discard the whole run.`;

type Worktree = { readonly path: string; readonly branch: string; readonly runId: string };

class DreamDiscard extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "DreamDiscard";
    this.reason = reason;
  }
}

class DreamTimeout extends Error {
  constructor() {
    super("dreaming run timed out");
    this.name = "DreamTimeout";
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
  // Reminder behavior keeps its small amount of state in memory and writes no file, as designed.
  #reminderTurns = 0;
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
    if (this.#options.config.behavior === "reminder") {
      this.#reminderTurns += 1;
      if (this.#reminderTurns >= this.#options.config.turns) {
        this.#reminderTurns = 0;
        this.#reminderDue = true;
        this.#log({ event: "dreaming.trigger", action: "reminder", turns: 0 });
      }
      return;
    }
    await this.#load();
    this.#state = { ...this.#state, turnsSinceApply: this.#state.turnsSinceApply + 1 };
    await this.#persist();
    if (this.#state.turnsSinceApply < this.#options.config.turns) return;
    this.#schedule("turns");
  }

  async compactionCompleted(): Promise<void> {
    if (this.#closed || !this.#options.config.enabled || !this.#options.config.onCompaction) return;
    if (this.#options.config.behavior === "reminder") {
      this.#reminderDue = true;
      this.#log({ event: "dreaming.trigger", action: "reminder", turns: 0 });
      return;
    }
    await this.#load();
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
    this.#abort = adapter;
    let worktree: Worktree | undefined;
    let applied = false;
    try {
      await this.#load();
      await this.#options.memory.ensure();
      const input = await this.#options.input({ archiveThrough: this.#state.archiveThrough });
      const turns = this.#state.turnsSinceApply;
      const runId = await this.#newRunId();
      const base = (await git(this.#options.memory.directory, ["rev-parse", "HEAD"])).trim();
      worktree = {
        runId,
        branch: `${BRANCH_PREFIX}${runId}`,
        path: join(this.#options.dataDir, "dreaming", "worktrees", runId),
      };
      await mkdir(dirname(worktree.path), { recursive: true });
      await rm(worktree.path, { recursive: true, force: true });
      // A crashed earlier process leaves a registered worktree and branch behind; neither may
      // block this run.
      await gitTry(this.#options.memory.directory, ["worktree", "remove", "--force", worktree.path]);
      await gitTry(this.#options.memory.directory, ["worktree", "prune"]);
      await gitTry(this.#options.memory.directory, ["branch", "-D", worktree.branch]);
      await git(this.#options.memory.directory, ["worktree", "add", "-b", worktree.branch, worktree.path, base]);
      this.#log({ event: "dreaming.run.start", runId, action: reason, turns });

      const dreamPrompt = buildDreamPrompt(input, this.#options.timezone);
      await this.#runWithRetry(adapter.signal, {
        runId, role: "dream", cwd: worktree.path, instructions: DREAMING_INSTRUCTIONS, prompt: dreamPrompt,
      }, async () => {
        await git(worktree!.path, ["reset", "--hard", "HEAD"]);
        await git(worktree!.path, ["clean", "-fd"]);
      });

      await git(worktree.path, ["add", "-A"]);
      if ((await gitTry(worktree.path, ["diff", "--cached", "--quiet"])).code === 0) {
        throw new DreamDiscard("no-change");
      }
      const diff = (await git(worktree.path, ["diff", "--cached"])).slice(0, DIFF_MAX_CHARS);

      if (config.review) {
        this.#log({ event: "dreaming.run.review", runId });
        const verdictText = await this.#withTimeout(adapter.signal, (signal) => this.#options.run({
          runId,
          role: "review",
          cwd: worktree!.path,
          instructions: REVIEW_INSTRUCTIONS,
          prompt: buildReviewPrompt(diff, input),
          signal,
        }));
        const verdict = parseVerdict(verdictText);
        if (verdict === undefined) throw new DreamDiscard("review-invalid");
        if (verdict.revert.length > 0) {
          for (const path of verdict.revert) await revertPath(worktree.path, path);
          await git(worktree.path, ["add", "-A"]);
        }
        if (verdict.verdict !== "apply") throw new DreamDiscard("review-rejected");
        if ((await gitTry(worktree.path, ["diff", "--cached", "--quiet"])).code === 0) {
          throw new DreamDiscard("no-change");
        }
      }

      if (config.dryRun) {
        this.#log({ event: "dreaming.run.discarded", runId, action: "dry-run", turns });
        await this.#record({ startedAt, status: "dry-run", commit: null, reason: null });
        return;
      }

      // Apply, per ADR-0001: commit the worktree, commit a dirty live tree, then fast-forward.
      await git(worktree.path, ["commit", "--no-verify", "-m", commitMessage(runId, turns, this.#now())]);
      await this.#options.memory.commitDirty("owner", "pre-dreaming-apply");
      const liveHead = (await git(this.#options.memory.directory, ["rev-parse", "HEAD"])).trim();
      if (liveHead !== base) {
        // The live branch advanced while the run worked. Rebase the reviewed commit onto it so the
        // apply is still a fast-forward; a real conflict is the discard path, never a forced merge.
        const rebase = await gitTry(worktree.path, ["rebase", liveHead]);
        if (rebase.code !== 0) {
          await gitTry(worktree.path, ["rebase", "--abort"]);
          throw new DreamDiscard("conflict");
        }
      }
      const merge = await gitTry(this.#options.memory.directory, ["merge", "--ff-only", worktree.branch]);
      if (merge.code !== 0) throw new DreamDiscard("merge-failed");
      const commit = (await git(this.#options.memory.directory, ["rev-parse", "HEAD"])).trim();
      applied = true;
      await this.#record(
        { startedAt, status: "applied", commit, reason: null },
        {
          turnsSinceApply: 0,
          lastAppliedCommit: commit,
          failure: null,
          ...(input.archiveThrough === null ? {} : { archiveThrough: input.archiveThrough }),
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
      } else if (error instanceof DreamTimeout) {
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
      this.#abort = undefined;
      if (worktree !== undefined) await this.#discardWorktree(worktree, applied);
    }
  }

  async #record(
    entry: { startedAt: string; status: DreamingRunStatus; commit: string | null; reason: string | null },
    next?: Partial<Pick<DreamingState, "turnsSinceApply" | "lastAppliedCommit" | "failure" | "archiveThrough">>,
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
        return await this.#withTimeout(signal, (turnSignal) => this.#options.run({ ...input, signal: turnSignal }));
      } catch (error) {
        if (error instanceof DreamTimeout || signal.aborted || attempt >= 2) throw error;
        // A transient model failure earns exactly one retry, from a clean worktree.
        this.#log({ event: "dreaming.run.start", runId: input.runId, action: "retry" });
        await reset();
        await delay(RETRY_DELAY_MS, signal);
      }
    }
  }

  async #withTimeout(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<string>): Promise<string> {
    const timeout = AbortSignal.timeout(this.#options.config.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      return await abortable(operation(combined), combined);
    } catch (error) {
      if (timeout.aborted && !signal.aborted) throw new DreamTimeout();
      throw error;
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
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      this.#state = parseState(parsed);
    } catch {
      // Never guess at a damaged state file; start clean and let the operator inspect the old one.
      this.#log({ event: "dreaming.state.corrupt" });
      this.#state = emptyState();
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
    archiveThrough: null,
  };
}

/** Strict enough for a host-owned file; a malformed field sends the whole state back to empty. */
function parseState(value: unknown): DreamingState {
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
  const archiveThrough = nullableString(record.archiveThrough);
  return { version: STATE_VERSION, turnsSinceApply, lastRun, lastAppliedCommit, failure, archiveThrough };
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

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("bad string");
  return value;
}

// --- prompts and review -----------------------------------------------------------------------

function buildDreamPrompt(input: DreamingInput, timezone: string): string {
  return `Recent owner turns (oldest first, already bounded):
---
${input.transcript === "" ? "(none)" : input.transcript}
---

Daily archive since the last applied run:
---
${input.archive === "" ? "(none)" : input.archive}
---

Consolidate this into core memory now. Times are in ${timezone}. Finish every edit, then reply with one line.`;
}

function buildReviewPrompt(diff: string, input: DreamingInput): string {
  return `Staged diff proposed by the dream pass:
---
${diff}
---

Transcript the dream pass was given:
---
${input.transcript === "" ? "(none)" : input.transcript}
---

Reply with one JSON object.`;
}

type Verdict = { readonly verdict: "apply" | "reject"; readonly revert: readonly string[] };

function parseVerdict(text: string): Verdict | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.verdict !== "apply" && record.verdict !== "reject") return undefined;
  const revert = Array.isArray(record.revert)
    ? record.revert.filter((item): item is string => typeof item === "string")
    : [];
  return { verdict: record.verdict, revert };
}

/** Undo one file in the worktree: restore a tracked file, remove one the run added. */
async function revertPath(worktree: string, path: string): Promise<void> {
  const root = resolve(worktree);
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${root}${sep}`) || path.split("/").includes(".git")) return;
  const tracked = await gitTry(root, ["cat-file", "-e", `HEAD:${path}`]);
  if (tracked.code === 0) {
    await gitTry(root, ["checkout", "HEAD", "--", path]);
    return;
  }
  await gitTry(root, ["rm", "--cached", "--ignore-unmatch", "-f", "--", path]);
  await rm(absolute, { force: true });
}

// --- git --------------------------------------------------------------------------------------

function git(directory: string, args: readonly string[]): Promise<string> {
  return gitRun(directory, args).then((result) => {
    if (result.code !== 0) {
      const detail = result.stderr.trim().split("\n").at(-1) ?? "";
      throw Object.assign(new Error(`dreaming git failed${detail === "" ? "" : `: ${detail}`}`), { code: "DREAMING_GIT_FAILED" });
    }
    return result.stdout;
  });
}

function gitTry(directory: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return gitRun(directory, args);
}

function gitRun(directory: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!isAbsolute(directory)) {
    return Promise.resolve({ code: 1, stdout: "", stderr: "memory directory must be absolute" });
  }
  return new Promise((resolvePromise) => {
    execFile("git", ["-C", directory, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
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

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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
