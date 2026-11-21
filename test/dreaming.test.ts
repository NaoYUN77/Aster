import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
    review: true,
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

const APPLY = '{"verdict":"apply","reason":"grounded","revert":[]}';

function writingRun(body = "color: blue\n"): DreamingTurn {
  return async (input) => {
    if (input.role === "dream") {
      await writeFile(join(input.cwd, "MEMORY.md"), body, "utf8");
      return "updated MEMORY.md";
    }
    return APPLY;
  };
}

// ---------------------------------------------------------------------------
// 1: threshold -> worktree -> edit -> review -> fast-forward apply
// ---------------------------------------------------------------------------

test("dreaming: a threshold applies a reviewed MEMORY.md change and resets the counter", { timeout: 60_000 }, async () => {
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
    assert.equal((await f.calls.filter((call) => call.role === "review")).length, 1);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2: review rejection discards without touching the live tree
// ---------------------------------------------------------------------------

test("dreaming: a rejected review discards the worktree and does not consume the counter", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({
    run: async (input) => input.role === "dream"
      ? (await writeFile(join(input.cwd, "MEMORY.md"), "color: red\n", "utf8"), "updated")
      : '{"verdict":"reject","reason":"ungrounded","revert":[]}',
  });
  try {
    await runner.observeTurn();
    await runner.observeTurn();
    await runner.whenIdle();

    const state = await f.state();
    assert.equal(state.turnsSinceApply, 2, "only an applied run consumes the counter");
    assert.equal(state.lastRun?.status, "discarded");
    assert.equal(state.lastRun?.reason, "review-rejected");
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "");
    assert.equal(f.events.includes("dreaming.run.discarded"), true);
    assert.equal((await git(f.memoryDir, ["branch", "--list", "dreaming/*"])).trim(), "");
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
      if (input.role !== "dream") return APPLY;
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
    overrides: { turns: 1, timeoutMs: 100 },
    run: async (input) => {
      if (input.role === "review") return APPLY;
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
      if (input.role === "review") return APPLY;
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
// 6: dry run reviews but never merges
// ---------------------------------------------------------------------------

test("dreaming: a dry run records the run, applies nothing and keeps the counter", { timeout: 60_000 }, async () => {
  const { runner, fixture: f } = await fixture({ overrides: { turns: 1, dryRun: true }, run: writingRun() });
  try {
    await runner.observeTurn();
    await runner.whenIdle();
    const state = await f.state();
    assert.equal(state.lastRun?.status, "dry-run");
    assert.equal(state.lastRun?.commit, null);
    assert.equal(state.turnsSinceApply, 1);
    assert.equal(state.lastAppliedCommit, null);
    assert.equal(await readFile(join(f.memoryDir, "MEMORY.md"), "utf8"), "");
    assert.equal((await git(f.memoryDir, ["log", "--format=%s"])).includes("dream run"), false);
    assert.equal(f.calls.filter((call) => call.role === "review").length, 1, "review still runs");
    assert.equal((await git(f.memoryDir, ["branch", "--list", "dreaming/*"])).trim(), "");
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
      if (input.role === "review") return APPLY;
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
    review: true,
    dryRun: false,
    timeoutMs: 120_000,
  });
  const custom = readDreamingConfig({
    DREAMING_ENABLED: "0",
    DREAMING_TURNS: "5",
    DREAMING_ON_COMPACTION: "0",
    DREAMING_BEHAVIOR: "reminder",
    DREAMING_REVIEW: "0",
    DREAMING_DRY_RUN: "1",
    DREAMING_TIMEOUT_MS: "5000",
  });
  assert.deepEqual(custom, {
    enabled: false,
    turns: 5,
    onCompaction: false,
    behavior: "reminder",
    review: false,
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
    { DREAMING_REVIEW: "2" },
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
// 11: reminder behavior nudges once and writes nothing
// ---------------------------------------------------------------------------

test("dreaming: reminder behavior nudges the next request and writes no file", { timeout: 30_000 }, async () => {
  const { runner, fixture: f } = await fixture({ overrides: { behavior: "reminder", turns: 1 }, run: writingRun() });
  try {
    await runner.observeTurn();
    assert.equal(f.calls.length, 0);
    const line = runner.reminderLine();
    assert.match(line ?? "", /memory review is due/);
    assert.equal(runner.reminderLine(), undefined, "the reminder is consumed exactly once");
    await assert.rejects(stat(join(f.memoryDir, ".aster", "dreaming.json")), /ENOENT/);
  } finally {
    await f.cleanup();
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
      TELEGRAM_BOT_TOKEN: "offline-test",
      TELEGRAM_OWNER_ID: "1",
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
