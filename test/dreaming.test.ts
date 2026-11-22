import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import type { EntryId } from "@earendil-works/pi-durable";
import { openAgent } from "../src/agent.js";
import { readConfig, readDreamingConfig, removedConfigKeys } from "../src/config.js";
import { ConfigurationError } from "../src/errors.js";
import { dreamingStatus, formatDreamingStatus } from "../src/dreaming-cli.js";
import { createMemoryFs } from "../src/memory-fs.js";
import {
  createDreamingRunner,
  type DreamingClock,
  type DreamingConfig,
  type DreamingState,
  type DreamingTurn,
  type DreamingTurnInput,
} from "../src/memory/integration.js";

const running = new AbortController().signal;

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a dreaming condition");
    await delay(10);
  }
}

/**
 * A deterministic wall clock: timers are recorded and only the caller's `advanceTo` fires them.
 * Advancing yields to the event loop so a fired timer can reach its first `await`.
 */
function fakeClock(start: string): DreamingClock & { advanceTo(iso: string): Promise<void> } {
  let now = Date.parse(start);
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    async advanceTo(iso) {
      now = Date.parse(iso);
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (due === undefined) return;
        timers.delete(due[0]);
        due[1].callback();
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      }
    },
  };
}

async function writeState(memoryDir: string, state: Record<string, unknown>): Promise<void> {
  await mkdir(join(memoryDir, ".aster"), { recursive: true });
  await writeFile(join(memoryDir, ".aster", "dreaming.json"), JSON.stringify({ version: 1, ...state }), "utf8");
}

/** Leftovers in the staging root; an applied or discarded run leaves none. */
async function stagingRuns(root: string): Promise<string[]> {
  return readdir(join(root, "dreaming", "staging")).catch(() => [] as string[]);
}

function config(overrides: Partial<DreamingConfig> = {}): DreamingConfig {
  return {
    enabled: true,
    at: "04:00",
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
  readonly evidenceThrough?: EntryId | null;
  readonly initialMemory?: string;
  readonly clock?: DreamingClock;
  readonly timezone?: string;
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
    timezone: options.timezone ?? "UTC",
    run: (input) => {
      calls.push(input);
      return options.run(input);
    },
    // The evidence deliberately names a live memory path; the run must rewrite it to staging.
    input: async () => ({
      transcript: `user: my color is blue; read ${join(memoryDir, "notes", "color.md")} first`,
      activity: `## 2026-11-20\n[09:00] tool read: {"path":"${join(memoryDir, "notes", "color.md")}"}`,
      evidenceThrough: options.evidenceThrough ?? (7 as EntryId),
    }),
    log: (event) => events.push(event.event),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
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
// 1: nightly schedule -> staging copy -> edit -> layout check -> compare-and-swap apply
// ---------------------------------------------------------------------------

test("dreaming: the nightly timer fires at DREAMING_AT and never twice on one local date", { timeout: 60_000 }, async () => {
  const clock = fakeClock("2026-11-21T03:59:00Z");
  const { runner, fixture: f } = await fixture({ run: writingRun(), clock });
  try {
    await runner.start();
    await clock.advanceTo("2026-11-21T03:59:59Z");
    assert.equal(f.calls.length, 0, "nothing runs before the configured time");

    await clock.advanceTo("2026-11-21T04:00:00Z");
    await until(() => f.calls.length === 1);
    await runner.whenIdle();

    const state = await f.state();
    assert.equal(state.lastNightlyDate, "2026-11-21");
    assert.equal(state.lastRun?.status, "applied");
    assert.match(state.lastAppliedSnapshot ?? "", /-dreaming-pre-dreaming-apply/u, "the undo point is a pre-apply snapshot");
    assert.equal(state.evidenceThrough, 7);
    assert.equal("archiveThrough" in state, false, "the date cursor is gone from the state file");
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "color: blue\n");
    assert.deepEqual(await stagingRuns(f.root), []);
    assert.equal(f.events.filter((event) => event === "dreaming.run.applied").length, 1);

    // The evidence named live memory; the model was pointed at the staging copy instead.
    const turn = f.calls[0]!;
    assert.equal(turn.prompt.includes(f.memoryDir), false, "live memory paths are rewritten out of the evidence");
    assert.ok(turn.prompt.includes(join(f.root, "dreaming", "staging")), "the evidence points at the staging copy");
    assert.ok(turn.cwd.startsWith(join(f.root, "dreaming", "staging")));
    assert.match(turn.instructions, /staging copy/u);
    assert.match(turn.instructions, /do not run git/iu, "the brief forbids git instead of relying on it");

    // The rest of the day, including a timer that keeps firing, never runs again.
    await clock.advanceTo("2026-11-21T18:00:00Z");
    assert.equal(f.calls.length, 1);
    assert.equal((await f.state()).lastNightlyDate, "2026-11-21");

    // The next local date is a new night.
    await clock.advanceTo("2026-11-22T04:00:00Z");
    await until(() => f.calls.length === 2);
    await runner.whenIdle();
    assert.equal((await f.state()).lastNightlyDate, "2026-11-22");
  } finally {
    await f.cleanup();
  }
});

test("dreaming: a restart past DREAMING_AT catches up the same local date exactly once", { timeout: 60_000 }, async () => {
  const clock = fakeClock("2026-11-21T09:15:00Z");
  const { runner, fixture: f } = await fixture({ run: writingRun(), clock });
  try {
    await writeState(f.memoryDir, { lastNightlyDate: "2026-11-20", lastRun: null, lastAppliedSnapshot: null, failure: null, archiveThrough: null });
    await runner.start();
    await until(() => f.calls.length === 1);
    await runner.whenIdle();
    assert.equal((await f.state()).lastNightlyDate, "2026-11-21");

    // A second process on the same day loads the claimed date and stays quiet.
    const restarted = createDreamingRunner({
      config: config(),
      memory: f.memory,
      dataDir: f.root,
      timezone: "UTC",
      run: async () => "unexpected",
      input: async () => ({ transcript: "", activity: "", evidenceThrough: null }),
      clock: fakeClock("2026-11-21T12:00:00Z"),
    });
    try {
      await restarted.start();
      assert.equal(f.calls.length, 1, "the same local date is never caught up twice");
    } finally {
      restarted.close();
      await restarted.whenIdle();
    }
  } finally {
    await f.cleanup();
  }
});

test("dreaming: DREAMING_AT is interpreted in the memory timezone", { timeout: 60_000 }, async () => {
  // 19:59Z is 03:59 on 2026-11-22 in Asia/Shanghai; 20:00Z is 04:00 there.
  const clock = fakeClock("2026-11-21T19:59:00Z");
  const { runner, fixture: f } = await fixture({ run: writingRun(), clock, timezone: "Asia/Shanghai" });
  try {
    await runner.start();
    await clock.advanceTo("2026-11-21T19:59:59Z");
    assert.equal(f.calls.length, 0, "UTC midnight has nothing to do with the local trigger");
    await clock.advanceTo("2026-11-21T20:00:00Z");
    await until(() => f.calls.length === 1);
    await runner.whenIdle();
    const state = await f.state();
    assert.equal(state.lastNightlyDate, "2026-11-22", "the local date, not the UTC date");
    assert.equal(state.lastRun?.status, "applied");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 1b: a dream that writes outside its staging copy is undone, not applied
// ---------------------------------------------------------------------------

test("dreaming: a dream that writes into live memory is discarded, live is restored, and the leak is kept", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({
    initialMemory: "color: unknown\n",
    run: async (input) => {
      await writeFile(join(input.cwd, "MEMORY.md"), "color: blue\n", "utf8");
      // The model escapes its staging copy and edits live memory directly.
      await mkdir(join(f.memoryDir, "notes"), { recursive: true });
      await writeFile(join(f.memoryDir, "MEMORY.md"), "hijacked\n", "utf8");
      await writeFile(join(f.memoryDir, "notes", "leak.md"), "leaked\n", "utf8");
      return "updated";
    },
  });
  try {
    await runner.compactionCompleted();
    await runner.whenIdle();

    const state = await f.state();
    assert.equal(state.lastRun?.status, "discarded");
    assert.equal(state.lastRun?.reason, "live-modified");
    assert.equal(state.lastAppliedSnapshot, null);
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "color: unknown\n", "live is put back");
    assert.equal(
      await readFile(join(f.memoryDir, "notes", "leak.md"), "utf8").catch(() => "gone"),
      "gone",
      "the leaked file is removed from live",
    );
    assert.deepEqual(await stagingRuns(f.root), []);
    assert.equal(f.events.includes("dreaming.run.live"), true, "the leak is visible in observation");

    // Nothing is silently destroyed: the leaked bytes survive as a pre-restore snapshot.
    const snapshots = await f.memory.history(10);
    const preserved = snapshots.find((snapshot) => snapshot.reason === "pre-restore");
    assert.ok(preserved, "the restore kept what it replaced");
    assert.equal(
      await readFile(join(f.memoryDir, ".aster", "versions", preserved.id, "tree", "notes", "leak.md"), "utf8"),
      "leaked\n",
    );
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
    await runner.compactionCompleted();
    await runner.whenIdle();

    const state = await f.state();
    assert.equal(state.lastRun?.status, "discarded");
    assert.equal(state.lastRun?.reason, "layout-invalid");
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "");
    assert.deepEqual(await stagingRuns(f.root), []);
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
      // The owner edits the live tree while the run works; the turn boundary snapshots it.
      await writeFile(join(f.memoryDir, "MEMORY.md"), "color: green\n", "utf8");
      await f.memory.snapshotDirty("owner", "pre-render");
      return "updated";
    },
  });
  try {
    await runner.compactionCompleted();
    await runner.whenIdle();

    const state = await f.state();
    assert.equal(state.lastRun?.status, "discarded");
    assert.equal(state.lastRun?.reason, "conflict");
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "color: green\n");
    assert.deepEqual(await stagingRuns(f.root), []);
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
    overrides: { timeoutMs: 3_000 },
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
    await runner.compactionCompleted();
    await runner.whenIdle();
    let state = await f.state();
    assert.equal(state.lastRun?.status, "discarded");
    assert.equal(state.lastRun?.reason, "timeout");
    assert.deepEqual(await stagingRuns(f.root), []);

    // The next trigger is admitted: no backoff from a timeout, no stuck runner.
    await runner.compactionCompleted();
    await runner.whenIdle();
    state = await f.state();
    assert.equal(state.lastRun?.status, "applied");
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
    overrides: {},
    run: async (input) => {
      dreamAttempts += 1;
      if (dreamAttempts === 1) throw new Error("transient provider failure");
      await writeFile(join(input.cwd, "MEMORY.md"), "color: blue\n", "utf8");
      return "updated";
    },
  });
  try {
    await runner.compactionCompleted();
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
// 6: dry run evaluates the layout but never applies
// ---------------------------------------------------------------------------

test("dreaming: a dry run applies nothing and claims no undo snapshot", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({ overrides: { dryRun: true }, run: writingRun() });
  try {
    await runner.compactionCompleted();
    await runner.whenIdle();
    const state = await f.state();
    assert.equal(state.lastRun?.status, "dry-run");
    assert.equal(state.lastRun?.snapshot, null);
    assert.equal(state.lastAppliedSnapshot, null);
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "");
    assert.equal(f.calls.length, 1, "one dream turn per dry run");
    assert.deepEqual(await stagingRuns(f.root), []);

    // A later compaction is a new trigger; a dry run never blocks the next night.
    await runner.compactionCompleted();
    await runner.whenIdle();
    assert.equal(f.calls.length, 2);
    assert.equal((await f.state()).lastRun?.status, "dry-run");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7: compaction triggers a run without any turn threshold being reached
// ---------------------------------------------------------------------------

test("dreaming: a completed compaction triggers a run", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({ run: writingRun() });
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
    at: "04:00",
    onCompaction: true,
    behavior: "auto-launch",
    dryRun: false,
    timeoutMs: 120_000,
  });
  const custom = readDreamingConfig({
    DREAMING_ENABLED: "0",
    DREAMING_AT: "23:05",
    DREAMING_ON_COMPACTION: "0",
    DREAMING_BEHAVIOR: "reminder",
    DREAMING_DRY_RUN: "1",
    DREAMING_TIMEOUT_MS: "5000",
  });
  assert.deepEqual(custom, {
    enabled: false,
    at: "23:05",
    onCompaction: false,
    behavior: "reminder",
    dryRun: true,
    timeoutMs: 5_000,
  });
  // DREAMING_TURNS is a removed key: leftovers are reported by name, never read as settings.
  assert.deepEqual(readDreamingConfig({ DREAMING_TURNS: "5" }), defaults);
  assert.deepEqual(removedConfigKeys({ DREAMING_TURNS: "5" }), ["DREAMING_TURNS"]);
  const invalid: NodeJS.ProcessEnv[] = [
    { DREAMING_ENABLED: "yes" },
    { DREAMING_AT: "4:00" },
    { DREAMING_AT: "24:00" },
    { DREAMING_AT: "04:60" },
    { DREAMING_AT: "0400" },
    { DREAMING_AT: "04:00:00" },
    { DREAMING_AT: "night" },
    { DREAMING_BEHAVIOR: "sometimes" },
    { DREAMING_TIMEOUT_MS: "999" },
    { DREAMING_TIMEOUT_MS: "600001" },
    { DREAMING_TIMEOUT_MS: "fast" },
    { DREAMING_DRY_RUN: "true" },
    // A disabled feature still validates every other value.
    { DREAMING_ENABLED: "0", DREAMING_AT: "25:00" },
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
  const clock = fakeClock("2026-11-21T05:00:00Z");
  const { runner, fixture: f } = await fixture({ overrides: { enabled: false }, run: writingRun(), clock });
  try {
    await runner.start();
    await clock.advanceTo("2026-11-22T05:00:00Z");
    await runner.compactionCompleted();
    await runner.whenIdle();
    assert.equal(f.calls.length, 0);
    assert.equal(runner.reminderLine(), undefined);
    await assert.rejects(stat(join(f.memoryDir, ".aster", "dreaming.json")), /ENOENT/);
    await assert.rejects(stat(join(f.root, "dreaming")), /ENOENT/);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 11: reminder behavior persists its counter across runners
// ---------------------------------------------------------------------------

test("dreaming: reminder behavior nudges at the nightly time, once per local date", { timeout: 30_000 }, async () => {
  const clock = fakeClock("2026-11-21T03:00:00Z");
  const { runner, fixture: f } = await fixture({ overrides: { behavior: "reminder" }, run: writingRun(), clock });
  try {
    await runner.start();
    assert.equal(runner.reminderLine(), undefined, "nothing is due before the time");
    await clock.advanceTo("2026-11-21T04:00:00Z");
    await until(() => f.events.includes("dreaming.trigger"));
    assert.match(runner.reminderLine() ?? "", /memory review is due/);
    assert.equal(runner.reminderLine(), undefined, "the reminder is consumed exactly once");
    assert.equal(f.calls.length, 0, "reminder behavior never launches a background run");
    assert.equal((await f.state()).lastNightlyDate, "2026-11-21");

    // A restart on the same day does not nudge again.
    const restarted = createDreamingRunner({
      config: config({ behavior: "reminder" }),
      memory: f.memory,
      dataDir: f.root,
      timezone: "UTC",
      run: async (input) => {
        f.calls.push(input);
        return "unexpected";
      },
      input: async () => ({ transcript: "", activity: "", evidenceThrough: null }),
      clock: fakeClock("2026-11-21T12:00:00Z"),
    });
    try {
      await restarted.start();
      assert.equal(restarted.reminderLine(), undefined, "the local date was already claimed");
    } finally {
      restarted.close();
      await restarted.whenIdle();
    }
  } finally {
    await f.cleanup();
  }
});

test("dreaming: an old turn-counter state file still loads, drops removed fields, and migrates the git-era pointer", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-dreaming-old-state-"));
  const memoryDir = join(root, "memory-fs");
  const memory = createMemoryFs({ dir: memoryDir });
  const runner = createDreamingRunner({
    config: config({ behavior: "reminder" }),
    memory,
    dataDir: root,
    timezone: "UTC",
    run: async () => "unexpected",
    input: async () => ({ transcript: "", activity: "", evidenceThrough: null }),
  });
  try {
    await memory.ensure();
    await writeState(memoryDir, {
      turnsSinceApply: 4,
      lastRun: null,
      // A git-era file named the applied commit; it is read as the snapshot pointer it now is.
      lastAppliedCommit: "cda51a5fd466543cc8a8a20f121e867896c00a1b",
      failure: null,
      archiveThrough: "2026-11-20",
    });
    const state = await runner.status();
    assert.equal(state.lastNightlyDate, null, "an old file has not claimed a night yet");
    assert.equal(state.evidenceThrough, null, "a date cursor from the archive era becomes no cursor");
    assert.equal(state.reminderTurns, 0);
    assert.equal(state.lastAppliedSnapshot, "cda51a5fd466543cc8a8a20f121e867896c00a1b", "the old pointer is not lost");
    assert.deepEqual(Object.keys(state).sort(), [
      "evidenceThrough", "failure", "lastAppliedSnapshot", "lastNightlyDate", "lastRun", "reminderTurns", "version",
    ]);
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
    overrides: { timeoutMs: 1_200 },
    run: async (input) => {
      // The turn outlives the 1200 ms run deadline, so nothing is staged in time.
      await delay(2_000, undefined, { signal: input.signal });
      await writeFile(join(input.cwd, "MEMORY.md"), "color: blue\n", "utf8");
      return "updated";
    },
  });
  try {
    await runner.compactionCompleted();
    await runner.whenIdle();
    const state = await f.state();
    assert.equal(state.lastRun?.status, "discarded");
    assert.equal(state.lastRun?.reason, "timeout");
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "");
    assert.deepEqual(await stagingRuns(f.root), [], "the staging copy is gone, not half-applied");
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
    run: async () => {
      attempts += 1;
      throw new Error("provider down");
    },
  });
  try {
    await runner.compactionCompleted();
    await runner.whenIdle();
    const state = await f.state();
    assert.equal(attempts, 2, "one retry, then stop");
    assert.equal(state.lastRun?.status, "failed");
    assert.equal(state.lastRun?.reason, "DREAMING_FAILED");
    assert.notEqual(state.failure, null);
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
// Crash leftovers: stale staging copies are pruned at startup
// ---------------------------------------------------------------------------

test("dreaming: initialization removes a staging copy a crashed process left behind", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({ run: writingRun() });
  try {
    const stale = join(f.root, "dreaming", "staging", "20261121T000000Z");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "MEMORY.md"), "half a run\n", "utf8");

    await runner.status();

    assert.deepEqual(await stagingRuns(f.root), [], "a fresh process owns no staging copy");
  } finally {
    await f.cleanup();
  }
});

test("dreaming status: an absent state file is an empty report", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-dreaming-status-"));
  try {
    const report = await dreamingStatus({ DATA_DIR: root });
    assert.equal(report.state, null);
    assert.match(formatDreamingStatus(report), /"state": null/u);
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
      // Removed counters from an older build: ignored on read and never projected.
      turnsSinceApply: 3,
      reminderTurns: 2,
      lastNightlyDate: "2026-11-21",
      lastRun: {
        startedAt: "2026-11-21T00:00:00.000Z",
        endedAt: "2026-11-21T00:00:01.000Z",
        status: "applied",
        // A git-era run record named the commit; it is read as the snapshot id it now is.
        commit: "0123456789abcdef0123456789abcdef01234567",
        reason: null,
      },
      lastAppliedCommit: "0123456789abcdef0123456789abcdef01234567",
      failure: null,
      evidenceThrough: 12,
      // Hostile extras a hand-edited file might carry; they must never reach the output.
      text: "SECRET MESSAGE BODY",
      apiKey: "sk-live-not-a-real-key",
    }), "utf8");

    const report = await dreamingStatus({ DATA_DIR: root });
    const text = formatDreamingStatus(report);
    assert.equal(report.state?.lastNightlyDate, "2026-11-21");
    assert.equal(report.state?.lastRun?.status, "applied");
    assert.equal(report.state?.lastRun?.snapshot, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(report.state?.lastAppliedSnapshot, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(text.includes("turnsSinceApply"), false, "removed fields are not projected");
    assert.equal(text.includes("SECRET MESSAGE BODY"), false);
    assert.equal(text.includes("sk-live-not-a-real-key"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End to end: the open agent catches up a nightly run through a real staging copy
// ---------------------------------------------------------------------------

/** The dream conversation is identified by its fixed brief, so call order never matters. */
function dreamContext(context: TranscriptContext): boolean {
  const system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
  return system.includes("Aster's dreaming pass");
}

test("dreaming: the open agent catches up the nightly run through a real staging copy", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-dreaming-agent-"));
  const memoryDir = join(directory, "memory-fs");
  const memory = createMemoryFs({ dir: memoryDir });
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    await memory.ensure();
    await writeFile(join(memoryDir, "MEMORY.md"), "persona: direct\n", "utf8");
    await memory.snapshotDirty("owner", "seed");
    const faux = fauxProvider({ provider: "openai" });
    const models = createModels();
    models.setProvider(faux.provider);
    let dreamTurns = 0;
    const router = (context: TranscriptContext) => {
      if (!dreamContext(context)) return fauxAssistantMessage("Noted.");
      dreamTurns += 1;
      if (dreamTurns === 1) {
        return fauxAssistantMessage(
          fauxToolCall("write", { path: "MEMORY.md", content: "persona: direct\ncolor: blue\n" }),
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage("Updated MEMORY.md with the color.");
    };
    faux.setResponses(Array.from({ length: 8 }, () => router));
    const appConfig = readConfig({
      WEB_OWNER_ID: "1",
      MODEL_PROVIDER: "openai",
      MODEL_ID: "faux-1",
      OPENAI_API_KEY: "offline-test",
      DATA_DIR: directory,
      // The process starts after this time, so startup catches up today's missed night.
      DREAMING_AT: "00:00",
      DREAMING_TIMEOUT_MS: "30000",
    });
    app = await openAgent(appConfig, models, undefined, { memoryFs: memory });
    assert.equal(await app.reply({
      requestId: "telegram:dream:1",
      conversationId: "telegram:test",
      senderId: "1",
      text: "My color is blue.",
    }, running), "Noted.");
    await until(() => dreamTurns >= 2);
    await app.dreamingIdle();

    assert.equal(await readFile(join(memoryDir, "MEMORY.md"), "utf8"), "persona: direct\ncolor: blue\n");
    const state = JSON.parse(await readFile(join(memoryDir, ".aster", "dreaming.json"), "utf8")) as DreamingState;
    assert.equal(state.lastRun?.status, "applied");
    assert.match(state.lastAppliedSnapshot ?? "", /-dreaming-pre-dreaming-apply/u);
    assert.match(state.lastNightlyDate ?? "", /^\d{4}-\d{2}-\d{2}$/u);
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
