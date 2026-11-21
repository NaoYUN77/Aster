import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { openAgent } from "../src/agent.js";
import { readConfig, readDreamingConfig } from "../src/config.js";
import { ConfigurationError } from "../src/errors.js";
import { dreamingStatus, formatDreamingStatus } from "../src/dreaming-cli.js";
import { createMemoryFs } from "../src/memory-fs.js";
import {
  createDreamingRunner,
  type DreamingConfig,
  type DreamingState,
  type DreamingTurn,
  type DreamingTurnInput,
} from "../src/memory/integration.js";

const run = promisify(execFile);
const running = new AbortController().signal;

async function git(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args]);
  return stdout;
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a dreaming condition");
    await delay(10);
  }
}

/** Leftovers in the worktree root; an applied or discarded run leaves none. */
async function worktreeRuns(root: string): Promise<string[]> {
  return readdir(join(root, "dreaming", "worktrees")).catch(() => [] as string[]);
}

function config(overrides: Partial<DreamingConfig> = {}): DreamingConfig {
  return {
    enabled: true,
    turns: 2,
    onCompaction: true,
    behavior: "auto-launch",
    dryRun: false,
    timeoutMs: 30_000,
    ...overrides,
  };
}

type Fixture = {
  readonly root: string;
  readonly memoryDir: string;
  readonly memory: ReturnType<typeof createMemoryFs>;
  readonly calls: DreamingTurnInput[];
  readonly events: string[];
  state: () => Promise<DreamingState>;
  cleanup: () => Promise<void>;
};

async function fixture(options: {
  readonly overrides?: Partial<DreamingConfig>;
  readonly run: DreamingTurn;
  readonly archiveThrough?: string | null;
  readonly initialMemory?: string;
  readonly now?: () => Date;
}): Promise<{ runner: ReturnType<typeof createDreamingRunner>; fixture: Fixture }> {
  const root = await mkdtemp(join(tmpdir(), "aster-dreaming-"));
  const memoryDir = join(root, "memory-fs");
  const memory = createMemoryFs({ dir: memoryDir });
  await memory.ensure();
  if (options.initialMemory !== undefined) await writeFile(join(memoryDir, "MEMORY.md"), options.initialMemory, "utf8");
  const calls: DreamingTurnInput[] = [];
  const events: string[] = [];
  const runner = createDreamingRunner({
    config: config(options.overrides),
    memory,
    dataDir: root,
    timezone: "UTC",
    run: (input) => {
      calls.push(input);
      return options.run(input);
    },
    input: async () => ({
      transcript: "user: my color is blue",
      archive: "[2026-11-20 decision] color is blue",
      archiveThrough: options.archiveThrough ?? "2026-11-20",
    }),
    log: (event) => events.push(event.event),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const state = async (): Promise<DreamingState> => JSON.parse(
    await readFile(join(memoryDir, ".aster", "dreaming.json"), "utf8"),
  ) as DreamingState;
  return {
    runner,
    fixture: {
      root,
      memoryDir,
      memory,
      calls,
      events,
      state,
      cleanup: async () => {
        runner.close();
        await runner.whenIdle();
        await rm(root, { recursive: true, force: true });
      },
    },
  };
}

function writingRun(body = "color: blue\n"): DreamingTurn {
  return async (input) => {
    await writeFile(join(input.cwd, "MEMORY.md"), body, "utf8");
    return "updated MEMORY.md";
  };
}

// ---------------------------------------------------------------------------
// 1: threshold -> worktree -> edit -> layout check -> fast-forward apply
// ---------------------------------------------------------------------------

test("dreaming: a threshold applies a MEMORY.md change and resets the counter", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({ run: writingRun() });
  try {
    await runner.observeTurn();
    assert.equal((await f.state()).turnsSinceApply, 1);
    await runner.observeTurn();
    await runner.whenIdle();

    const state = await f.state();
    assert.equal(state.turnsSinceApply, 0);
    assert.equal(state.lastRun?.status, "applied");
    assert.equal(state.lastAppliedCommit, (await git(f.memoryDir, ["rev-parse", "HEAD"])).trim());
    assert.equal(state.archiveThrough, "2026-11-20");
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "color: blue\n");
    assert.match(await git(f.memoryDir, ["log", "-1", "--format=%s"]), /^memory: dream run .* by dreaming at /);
    assert.equal((await git(f.memoryDir, ["branch", "--list", "dreaming/*"])).trim(), "");
    assert.equal(f.events.filter((event) => event === "dreaming.run.applied").length, 1);
  } finally {
    await f.cleanup();
  }
});

test("dreaming: a dream agent that commits inside the worktree still applies its change", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({
    run: async (input) => {
      await writeFile(join(input.cwd, "MEMORY.md"), "color: blue\n", "utf8");
      await git(input.cwd, ["add", "-A"]);
      await git(input.cwd, ["-c", "user.name=dream", "-c", "user.email=dream@local", "commit", "-m", "dream"]);
      return "committed and done";
    },
  });
  try {
    await runner.observeTurn();
    await runner.observeTurn();
    await runner.whenIdle();

    const state = await f.state();
    assert.equal(state.lastRun?.status, "applied");
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "color: blue\n");
    assert.equal((await git(f.memoryDir, ["log", "--format=%s"])).includes("dream run"), true);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2: a note the index does not link is a broken layout, not memory
// ---------------------------------------------------------------------------

test("dreaming: an unindexed note discards the run", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({
    run: async (input) => {
      await writeFile(join(input.cwd, "MEMORY.md"), "# Memory\n\n## Index\n- [Projects](projects.md)\n", "utf8");
      await writeFile(join(input.cwd, "projects.md"), "Aster.\n", "utf8");
      await writeFile(join(input.cwd, "stray.md"), "not in the index\n", "utf8");
      return "updated";
    },
  });
  try {
    await runner.observeTurn();
    await runner.observeTurn();
    await runner.whenIdle();

    const state = await f.state();
    assert.equal(state.turnsSinceApply, 2);
    assert.equal(state.lastRun?.status, "discarded");
    assert.equal(state.lastRun?.reason, "layout-invalid");
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "");
    assert.deepEqual(await worktreeRuns(f.root), []);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3: a live edit that conflicts with the dream discards the run
// ---------------------------------------------------------------------------

test("dreaming: a conflicting live change discards the run and leaves the live bytes alone", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({
    initialMemory: "color: unknown\n",
    run: async (input) => {
      await writeFile(join(input.cwd, "MEMORY.md"), "color: red\n", "utf8");
      // The owner edits the live tree while the run works.
      await writeFile(join(f.memoryDir, "MEMORY.md"), "color: green\n", "utf8");
      return "updated";
    },
  });
  try {
    await runner.observeTurn();
    await runner.observeTurn();
    await runner.whenIdle();

    const state = await f.state();
    assert.equal(state.turnsSinceApply, 2);
    assert.equal(state.lastRun?.status, "discarded");
    assert.equal(state.lastRun?.reason, "conflict");
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "color: green\n");
    assert.equal((await git(f.memoryDir, ["log", "--format=%s"])).includes("dream run"), false);
    assert.equal((await git(f.memoryDir, ["branch", "--list", "dreaming/*"])).trim(), "");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4: timeout discards promptly and does not block the next trigger
// ---------------------------------------------------------------------------

test("dreaming: a timeout discards the run and the runner stays usable", { timeout: 60_000 }, async () => {
  let timedOutOnce = false;
  const { runner, fixture: f } = await fixture({
    overrides: { turns: 1, timeoutMs: 3_000 },
    run: async (input) => {
      if (!timedOutOnce) {
        timedOutOnce = true;
        return new Promise<string>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          }, { once: true });
        });
      }
      await writeFile(join(input.cwd, "MEMORY.md"), "color: blue\n", "utf8");
      return "updated";
    },
  });
  try {
    await runner.observeTurn();
    await runner.whenIdle();
    let state = await f.state();
    assert.equal(state.lastRun?.status, "discarded");
    assert.equal(state.lastRun?.reason, "timeout");
    assert.equal(state.turnsSinceApply, 1, "a timeout does not consume the counter");
    assert.deepEqual(await worktreeRuns(f.root), []);

    // The next trigger is admitted: no backoff from a timeout, no stuck runner.
    await runner.compactionCompleted();
    await runner.whenIdle();
    state = await f.state();
    assert.equal(state.lastRun?.status, "applied");
    assert.equal(state.turnsSinceApply, 0);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5: one retry on a transient model failure
// ---------------------------------------------------------------------------

test("dreaming: a transient failure retries once and then applies", { timeout: 60_000 }, async () => {
  let dreamAttempts = 0;
  const { runner, fixture: f } = await fixture({
    overrides: { turns: 1 },
    run: async (input) => {
      dreamAttempts += 1;
      if (dreamAttempts === 1) throw new Error("transient provider failure");
      await writeFile(join(input.cwd, "MEMORY.md"), "color: blue\n", "utf8");
      return "updated";
    },
  });
  try {
    await runner.observeTurn();
    await runner.whenIdle();
    const state = await f.state();
    assert.equal(dreamAttempts, 2, "exactly one retry");
    assert.equal(state.lastRun?.status, "applied");
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "color: blue\n");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6: dry run evaluates the layout but never merges
// ---------------------------------------------------------------------------

test("dreaming: a dry run applies nothing and restarts the counter", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({ overrides: { turns: 2, dryRun: true }, run: writingRun() });
  try {
    await runner.observeTurn();
    await runner.observeTurn();
    await runner.whenIdle();
    let state = await f.state();
    assert.equal(state.lastRun?.status, "dry-run");
    assert.equal(state.lastRun?.commit, null);
    assert.equal(state.turnsSinceApply, 0, "a completed dry run is a finished cycle");
    assert.equal(state.lastAppliedCommit, null);
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "");
    assert.equal((await git(f.memoryDir, ["log", "--format=%s"])).includes("dream run"), false);
    assert.equal(f.calls.length, 1, "one dream turn per dry run");
    assert.equal((await git(f.memoryDir, ["branch", "--list", "dreaming/*"])).trim(), "");

    // The next run needs a full threshold again: one turn must not trigger anything.
    const callsAfterFirst = f.calls.length;
    await runner.observeTurn();
    await runner.whenIdle();
    assert.equal(f.calls.length, callsAfterFirst, "one turn is below the threshold again");
    assert.equal((await f.state()).turnsSinceApply, 1);
    await runner.observeTurn();
    await runner.whenIdle();
    state = await f.state();
    assert.equal(state.lastRun?.status, "dry-run");
    assert.equal(state.turnsSinceApply, 0);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7: compaction triggers a run without any turn threshold being reached
// ---------------------------------------------------------------------------

test("dreaming: a completed compaction triggers a run", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({ overrides: { turns: 50 }, run: writingRun() });
  try {
    await runner.compactionCompleted();
    await runner.whenIdle();
    const state = await f.state();
    assert.equal(state.lastRun?.status, "applied");
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "color: blue\n");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8: triggers during a run coalesce into exactly one pending run
// ---------------------------------------------------------------------------

test("dreaming: triggers during a run coalesce into one pending run", { timeout: 60_000 }, async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  let dreamRuns = 0;
  const { runner, fixture: f } = await fixture({
    overrides: { turns: 50 },
    run: async (input) => {
      dreamRuns += 1;
      if (dreamRuns === 1) {
        await writeFile(join(input.cwd, "MEMORY.md"), "color: blue\n", "utf8");
        await gate;
      } else {
        await writeFile(join(input.cwd, "MEMORY.md"), "color: blue\ncolor: green\n", "utf8");
      }
      return "updated";
    },
  });
  try {
    await runner.compactionCompleted();
    // The run is admitted synchronously; wait until its model turn is actually parked on the gate.
    await until(() => dreamRuns === 1);
    await runner.compactionCompleted();
    await runner.compactionCompleted();
    release();
    await runner.whenIdle();
    assert.equal(dreamRuns, 2, "one running plus one coalesced run, never a queue");
    assert.equal((await f.state()).lastRun?.status, "applied");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9: configuration defaults and validation
// ---------------------------------------------------------------------------

test("dreaming: configuration defaults, bounds and invalid values", () => {
  const defaults = readDreamingConfig({});
  assert.deepEqual(defaults, {
    enabled: true,
    turns: 20,
    onCompaction: true,
    behavior: "auto-launch",
    dryRun: false,
    timeoutMs: 120_000,
  });
  const custom = readDreamingConfig({
    DREAMING_ENABLED: "0",
    DREAMING_TURNS: "5",
    DREAMING_ON_COMPACTION: "0",
    DREAMING_BEHAVIOR: "reminder",
    DREAMING_DRY_RUN: "1",
    DREAMING_TIMEOUT_MS: "5000",
  });
  assert.deepEqual(custom, {
    enabled: false,
    turns: 5,
    onCompaction: false,
    behavior: "reminder",
    dryRun: true,
    timeoutMs: 5_000,
  });
  const invalid: NodeJS.ProcessEnv[] = [
    { DREAMING_ENABLED: "yes" },
    { DREAMING_TURNS: "0" },
    { DREAMING_TURNS: "10001" },
    { DREAMING_TURNS: "many" },
    { DREAMING_BEHAVIOR: "sometimes" },
    { DREAMING_TIMEOUT_MS: "999" },
    { DREAMING_TIMEOUT_MS: "600001" },
    { DREAMING_TIMEOUT_MS: "fast" },
    { DREAMING_DRY_RUN: "true" },
    // A disabled feature still validates every other value.
    { DREAMING_ENABLED: "0", DREAMING_TURNS: "0" },
    { DREAMING_ENABLED: "0", DREAMING_BEHAVIOR: "often" },
  ];
  for (const env of invalid) {
    assert.throws(() => readDreamingConfig(env), ConfigurationError, JSON.stringify(env));
  }
});

// ---------------------------------------------------------------------------
// 10: disabled dreaming never runs, counts or writes
// ---------------------------------------------------------------------------

test("dreaming: DREAMING_ENABLED=0 runs nothing and writes no state", { timeout: 30_000 }, async () => {
  const { runner, fixture: f } = await fixture({ overrides: { enabled: false, turns: 1 }, run: writingRun() });
  try {
    for (let turn = 0; turn < 3; turn += 1) await runner.observeTurn();
    await runner.compactionCompleted();
    await runner.whenIdle();
    assert.equal(f.calls.length, 0);
    await assert.rejects(stat(join(f.memoryDir, ".aster", "dreaming.json")), /ENOENT/);
    await assert.rejects(stat(join(f.root, "dreaming")), /ENOENT/);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 11: reminder behavior persists its counter across runners
// ---------------------------------------------------------------------------

test("dreaming: reminder progress survives a restart and nudges exactly once", { timeout: 30_000 }, async () => {
  const { runner, fixture: f } = await fixture({ overrides: { behavior: "reminder", turns: 2 }, run: writingRun() });
  try {
    await runner.observeTurn();
    assert.equal((await f.state()).reminderTurns, 1);
    assert.equal(runner.reminderLine(), undefined, "one turn is not enough");
    runner.close();

    // A second runner over the same repository is what a restart looks like.
    const restarted = createDreamingRunner({
      config: config({ behavior: "reminder", turns: 2 }),
      memory: f.memory,
      dataDir: f.root,
      timezone: "UTC",
      run: async (input) => {
        f.calls.push(input);
        return "unexpected";
      },
      input: async () => ({ transcript: "", archive: "", archiveThrough: null }),
    });
    try {
      assert.equal((await restarted.status()).reminderTurns, 1, "the counter continues, not restarts");
      await restarted.observeTurn();
      assert.equal((await f.state()).reminderTurns, 0, "the nudge settles the counter");
      assert.match(restarted.reminderLine() ?? "", /memory review is due/);
      assert.equal(restarted.reminderLine(), undefined, "the reminder is consumed exactly once");
      // No background run was ever dispatched; the counter file is the only write.
      assert.equal(f.calls.length, 0);
    } finally {
      restarted.close();
      await restarted.whenIdle();
    }
  } finally {
    await f.cleanup();
  }
});

test("dreaming: a state file from before reminderTurns loads with a zero counter", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-dreaming-old-state-"));
  const memoryDir = join(root, "memory-fs");
  const memory = createMemoryFs({ dir: memoryDir });
  const runner = createDreamingRunner({
    config: config({ behavior: "reminder" }),
    memory,
    dataDir: root,
    timezone: "UTC",
    run: async () => "unexpected",
    input: async () => ({ transcript: "", archive: "", archiveThrough: null }),
  });
  try {
    await memory.ensure();
    await mkdir(join(memoryDir, ".aster"), { recursive: true });
    await writeFile(join(memoryDir, ".aster", "dreaming.json"), JSON.stringify({
      version: 1,
      turnsSinceApply: 4,
      lastRun: null,
      lastAppliedCommit: null,
      failure: null,
      archiveThrough: null,
    }), "utf8");
    const state = await runner.status();
    assert.equal(state.turnsSinceApply, 4);
    assert.equal(state.reminderTurns, 0);
  } finally {
    runner.close();
    await runner.whenIdle();
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Whole-run deadline: the model turn and apply share one clock
// ---------------------------------------------------------------------------

test("dreaming: one deadline covers the whole run", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({
    overrides: { turns: 1, timeoutMs: 1_200 },
    run: async (input) => {
      // The turn outlives the 1200 ms run deadline, so nothing is staged in time.
      await delay(2_000, undefined, { signal: input.signal });
      await writeFile(join(input.cwd, "MEMORY.md"), "color: blue\n", "utf8");
      return "updated";
    },
  });
  try {
    await runner.observeTurn();
    await runner.whenIdle();
    const state = await f.state();
    assert.equal(state.lastRun?.status, "discarded");
    assert.equal(state.lastRun?.reason, "timeout");
    assert.equal(state.turnsSinceApply, 1, "a timeout does not consume the counter");
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "");
    assert.deepEqual(await worktreeRuns(f.root), [], "the worktree is gone, not half-applied");
    assert.equal((await git(f.memoryDir, ["branch", "--list", "dreaming/*"])).trim(), "");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Failures: status, failure record and backoff
// ---------------------------------------------------------------------------

test("dreaming: repeated model failure records the run and backs off", { timeout: 60_000 }, async () => {
  let attempts = 0;
  const { runner, fixture: f } = await fixture({
    overrides: { turns: 1 },
    run: async () => {
      attempts += 1;
      throw new Error("provider down");
    },
  });
  try {
    await runner.observeTurn();
    await runner.whenIdle();
    const state = await f.state();
    assert.equal(attempts, 2, "one retry, then stop");
    assert.equal(state.lastRun?.status, "failed");
    assert.equal(state.lastRun?.reason, "DREAMING_FAILED");
    assert.notEqual(state.failure, null);
    assert.equal(state.turnsSinceApply, 1, "a failed run does not consume the counter");
    assert.equal(f.events.includes("dreaming.run.failed"), true);

    // Backoff admits no immediate second run.
    await runner.compactionCompleted();
    await runner.whenIdle();
    assert.equal(attempts, 2, "the failure backoff blocks a new run");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Crash leftovers: stale dreaming branches are pruned at startup
// ---------------------------------------------------------------------------

test("dreaming: initialization prunes branches whose worktree is gone and keeps live ones", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({ run: writingRun() });
  const livePath = join(f.root, "kept-worktree");
  try {
    await git(f.memoryDir, ["branch", "dreaming/stale"]);
    await git(f.memoryDir, ["worktree", "add", "-b", "dreaming/kept", livePath]);
    await runner.status();

    const branches = (await git(f.memoryDir, ["branch", "--list", "dreaming/*", "--format=%(refname:short)"]))
      .split("\n").filter((line) => line !== "").sort();
    assert.deepEqual(branches, ["dreaming/kept"], "only the branch with a live worktree survives");
    assert.match(await git(f.memoryDir, ["worktree", "list", "--porcelain"]), /kept-worktree/u);
  } finally {
    await git(f.memoryDir, ["worktree", "remove", "--force", livePath]).catch(() => undefined);
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Status CLI: project only the durable fields
// ---------------------------------------------------------------------------

test("dreaming status: an absent state file is an empty report", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-dreaming-status-"));
  try {
    const report = await dreamingStatus({ DATA_DIR: root });
    assert.equal(report.state, null);
    const text = formatDreamingStatus(report);
    assert.match(text, /"state": null/);
    assert.equal(text.includes("No dream run has been recorded yet."), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dreaming status: only state fields are printed, never stray content", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-dreaming-status-"));
  try {
    const directory = join(root, "memory-fs");
    await mkdir(join(directory, ".aster"), { recursive: true });
    await writeFile(join(directory, ".aster", "dreaming.json"), JSON.stringify({
      version: 1,
      turnsSinceApply: 3,
      reminderTurns: 2,
      lastRun: {
        startedAt: "2026-11-21T00:00:00.000Z",
        endedAt: "2026-11-21T00:00:01.000Z",
        status: "applied",
        commit: "0123456789abcdef0123456789abcdef01234567",
        reason: null,
      },
      lastAppliedCommit: "0123456789abcdef0123456789abcdef01234567",
      failure: null,
      archiveThrough: "2026-11-20",
      // Hostile extras a hand-edited file might carry; they must never reach the output.
      text: "SECRET MESSAGE BODY",
      apiKey: "sk-live-not-a-real-key",
    }), "utf8");

    const report = await dreamingStatus({ DATA_DIR: root });
    const text = formatDreamingStatus(report);
    assert.equal(report.state?.turnsSinceApply, 3);
    assert.equal(report.state?.reminderTurns, 2);
    assert.equal(report.state?.lastRun?.status, "applied");
    assert.equal(text.includes("SECRET MESSAGE BODY"), false);
    assert.equal(text.includes("sk-live-not-a-real-key"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End to end: an owner turn triggers a real worktree run through the agent
// ---------------------------------------------------------------------------

test("dreaming: one owner turn drives a real worktree run through the open agent", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-dreaming-agent-"));
  const memoryDir = join(directory, "memory-fs");
  const memory = createMemoryFs({ dir: memoryDir });
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    await memory.ensure();
    await writeFile(join(memoryDir, "MEMORY.md"), "persona: direct\n", "utf8");
    await memory.commitDirty("owner", "seed");
    const faux = fauxProvider({ provider: "openai" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage("Noted."),
      fauxAssistantMessage(
        fauxToolCall("write", { path: "MEMORY.md", content: "persona: direct\ncolor: blue\n" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Updated MEMORY.md with the color."),
      fauxAssistantMessage('{"verdict":"apply","reason":"grounded","revert":[]}'),
    ]);
    const appConfig = readConfig({
      WEB_OWNER_ID: "1",
      MODEL_PROVIDER: "openai",
      MODEL_ID: "faux-1",
      OPENAI_API_KEY: "offline-test",
      DATA_DIR: directory,
      DREAMING_TURNS: "1",
      DREAMING_TIMEOUT_MS: "30000",
    });
    app = await openAgent(appConfig, models, undefined, { memoryFs: memory });
    assert.equal(await app.reply({
      requestId: "telegram:dream:1",
      conversationId: "telegram:test",
      senderId: "1",
      text: "My color is blue.",
    }, running), "Noted.");
    await app.dreamingIdle();

    assert.equal(await readFile(join(memoryDir, "MEMORY.md"), "utf8"), "persona: direct\ncolor: blue\n");
    assert.match(await git(memoryDir, ["log", "-1", "--format=%s"]), /^memory: dream run .* by dreaming at /);
    const state = JSON.parse(await readFile(join(memoryDir, ".aster", "dreaming.json"), "utf8")) as DreamingState;
    assert.equal(state.turnsSinceApply, 0);
    assert.equal(state.lastRun?.status, "applied");
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
