// MEM-07 acceptance (07-A ~ 07-G): the memory modules wired into the application lifecycle.
//
// Two fixture styles, mirroring test/durable.test.ts and test/memory-compaction.test.ts:
// the real `openAgent` composition for application behavior, and a raw Harness with the
// composition root attached directly where a test must drive one lifecycle step at a time
// (a projection whose input is never submitted, an upgrade built by hand, source scans).
// Everything runs on temporary directories with faux providers; no network, no real models.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  Harness,
  UsageDoc,
  type Conversation,
  type EntryId,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "../src/agent.js";
import { readConfig, readMemoryConfig } from "../src/config.js";
import { ConfigurationError } from "../src/errors.js";
import type { TextRequest } from "../src/messages.js";
import { createToolRegistry } from "../src/tools.js";
import { MEMORY_BUDGET_DEFAULTS } from "../src/memory/contracts.js";
import { applyWorkingUpdate } from "../src/memory/working.js";
import { readCompactionTurnCount } from "../src/memory/compaction.js";
import { snapshotOfProjection } from "../src/memory/context.js";
import {
  createMemoryIntegration,
  projectionRequestId,
  type MemoryIntegration,
  type MemoryLogEvent,
} from "../src/memory/integration.js";
import { withMemoryOff } from "./support/memory-off.js";

const context = BACKGROUND_CONTEXT;
const running = new AbortController().signal;
const INSTRUCTIONS = "SYSTEM RULES: be concise and cite memory sources.";

type AppConfig = ReturnType<typeof readConfig>;

function appConfig(dataDir: string, env: NodeJS.ProcessEnv = {}): AppConfig {
  const full = {
    WEB_OWNER_ID: "1",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: dataDir,
    ...env,
  };
  return { ...readConfig(full), memory: readMemoryConfig(full) } as AppConfig;
}

function modelFixture(provider = "openai") {
  const faux = fauxProvider({ provider });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

function request(id: string, text: string): TextRequest {
  return { requestId: `telegram:test:${id}`, conversationId: "telegram:test", senderId: "1", text };
}

async function until(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a durable condition");
    await delay(25);
  }
}

function transcriptText(messages: readonly Message[]): string {
  return JSON.stringify(messages);
}

/** Inspect the agent's database after the app closed: entries of the root conversation. */
async function inspectDatabase(dataDir: string, run: (harness: Harness, root: Conversation) => Promise<void>): Promise<void> {
  const harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, "agent.sqlite")), {
    models: createModels(),
    registry: createToolRegistry(),
  }, context);
  try {
    const root = await harness.root(context);
    await run(harness, root);
  } finally {
    await harness.close(context);
  }
}

async function allEntries(harness: Harness, root: Conversation): Promise<EntryRecord[]> {
  // Conversation.entries defaults to newest first; these tests reason chronologically.
  const page = await root.entries({ order: "ascending" }, 500, undefined, context);
  return [...page.items];
}

// ---------------------------------------------------------------------------
// 07-F: configuration schema, ranges, and distinct failure shapes
// ---------------------------------------------------------------------------

test("07-F: memory configuration defaults, overrides and invalid values", () => {
  const defaults = readMemoryConfig({});
  assert.equal(defaults.enabled, true);
  assert.deepEqual(defaults.budget, MEMORY_BUDGET_DEFAULTS);
  assert.equal(defaults.reserveTokens, 16_384);
  assert.equal(defaults.timezone, "UTC");

  const custom = readMemoryConfig({
    MEMORY_EVALUATE_AFTER_USER_TURNS: "5",
    MEMORY_TIMEZONE: "Asia/Shanghai",
    MEMORY_RESERVE_TOKENS: "8192",
  });
  assert.equal(custom.enabled, true);
  assert.equal(custom.budget.evaluateAfterUserTurns, 5);
  assert.equal(custom.timezone, "Asia/Shanghai");
  assert.equal(custom.reserveTokens, 8192);

  const invalid: NodeJS.ProcessEnv[] = [
    { MEMORY_EVALUATE_AFTER_USER_TURNS: "0" },
    { MEMORY_EVALUATE_AFTER_USER_TURNS: "1001" },
    { MEMORY_SNAPSHOT_TOKENS: "abc" },
    { MEMORY_RESERVE_TOKENS: "0" },
    { MEMORY_TIMEZONE: "Mars/Olympus" },
  ];
  for (const env of invalid) {
    assert.throws(() => readMemoryConfig(env), ConfigurationError, JSON.stringify(env));
  }

  // The memory section travels with the rest of the configuration: the agent must never fall back
  // to process defaults, so custom budgets must survive readConfig. There is no switch to disable
  // the system; a leftover MEMORY_ENABLED is reported by removedConfigKeys instead.
  const base = {
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: "memory-config-test",
  };
  const configured = readConfig({
    ...base,
    MEMORY_EVALUATE_AFTER_USER_TURNS: "3",
    MEMORY_TIMEZONE: "Asia/Shanghai",
    MEMORY_RESERVE_TOKENS: "8192",
  });
  assert.equal(configured.memory.enabled, true);
  assert.equal(configured.memory.budget.evaluateAfterUserTurns, 3);
  assert.equal(configured.memory.timezone, "Asia/Shanghai");
  assert.equal(configured.memory.reserveTokens, 8192);
});

// ---------------------------------------------------------------------------
// 07-A: requestId recovery adds nothing; a committed projection is reused
// ---------------------------------------------------------------------------

test("07-A: a replayed requestId adds no projection, model call or archive trigger", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mem07-replay-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const first = modelFixture();
    first.faux.setResponses([fauxAssistantMessage("first answer")]);
    app = await openAgent(appConfig(directory), first.models);
    assert.equal(await app.reply(request("1", "hello"), running), "first answer");
    await app.close();
    app = undefined;

    let entriesBefore: EntryId[] = [];
    await inspectDatabase(directory, async (harness, root) => {
      const entries = await allEntries(harness, root);
      entriesBefore = entries.map((entry) => entry.id);
      assert.equal(entries.filter((entry) => entry.kind === "personal.cycle").length, 1, "exactly one boundary projection");
      assert.equal(await readCompactionTurnCount(harness, root.id, context), 1);
    });

    const second = modelFixture();
    app = await openAgent(appConfig(directory), second.models);
    assert.equal(await app.reply(request("1", "hello"), running), "first answer");
    assert.equal(second.faux.state.callCount, 0, "a completed replay runs no model call");
    await app.close();
    app = undefined;

    await inspectDatabase(directory, async (harness, root) => {
      const entries = await allEntries(harness, root);
      assert.deepEqual(entries.map((entry) => entry.id), entriesBefore, "the replay added no entry at all");
      assert.equal(await readCompactionTurnCount(harness, root.id, context), 1, "the turn is not recounted");
    });

    // Same text under a different requestId is an independent request.
    const third = modelFixture();
    third.faux.setResponses([fauxAssistantMessage("second answer")]);
    app = await openAgent(appConfig(directory), third.models);
    assert.equal(await app.reply(request("2", "hello"), running), "second answer");
    assert.equal(third.faux.state.callCount, 1);
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

// ---------------------------------------------------------------------------
// Raw fixture: a Harness with the composition root attached, one step at a time
// ---------------------------------------------------------------------------

type RawFixture = {
  readonly directory: string;
  readonly database: string;
  readonly workspace: string;
  readonly faux: ReturnType<typeof modelFixture>["faux"];
  readonly integration: MemoryIntegration;
  readonly logs: MemoryLogEvent[];
  harness: Harness;
  root: Conversation;
};

async function openRaw(name: string, options: {
  readonly instructions?: string;
  readonly budget?: Partial<typeof MEMORY_BUDGET_DEFAULTS>;
  readonly dataDir?: string;
} = {}): Promise<RawFixture> {
  const directory = options.dataDir ?? await mkdtemp(join(tmpdir(), name));
  const database = join(directory, "agent.sqlite");
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "MEMORY.md"), "", { flag: "a" });
  const { faux, models } = modelFixture("faux");
  const logs: MemoryLogEvent[] = [];
  const budget = { ...MEMORY_BUDGET_DEFAULTS, ...options.budget };
  const integration = createMemoryIntegration({
    root: directory,
    instructions: options.instructions ?? INSTRUCTIONS,
    model: { provider: "faux", modelId: "faux-1" },
    contextWindow: 128_000,
    budget,
    reserveTokens: 16_384,
    timezone: "UTC",
    log: (event) => logs.push(event),
  });
  const registry = createToolRegistry();
  for (const extension of integration.extensions()) registry.install(extension);
  const harness = await Harness.open(await openNodeSqliteStorage(database), {
    models,
    registry,
    settings: { toolExecution: "sequential", compaction: integration.compactionSettings() },
  }, context);
  const root = await harness.root(context);
  await root.configure({
    model: { provider: "faux", modelId: "faux-1" },
    cwd: workspace,
    instructions: options.instructions ?? INSTRUCTIONS,
  }, context);
  integration.attach(harness, root);
  harness.resume();
  return { directory, database, workspace, faux, integration, logs, harness, root };
}

async function closeRaw(fixture: RawFixture): Promise<void> {
  fixture.integration.close();
  await fixture.harness.close(context).catch(() => {});
}

async function disposeRaw(fixture: RawFixture): Promise<void> {
  await closeRaw(fixture);
  await rm(fixture.directory, { recursive: true, force: true }).catch(() => {});
}

/** Drive one full request through the integration exactly as `agent.reply` does. */
async function driveRequest(fixture: RawFixture, id: string, text: string): Promise<string> {
  const prepared = await fixture.integration.prepareRequest({ requestId: id, text }, context);
  const submission = await fixture.root.submit({ type: "input", content: text, requestId: id }, context);
  const settled = await submission.wait(context);
  assert.equal(settled.status, "done", `request ${id} must complete`);
  if (prepared.kind !== "replay") await fixture.integration.afterRequest(id, context);
  return settled.status;
}

test("07-A: a projection whose input was never submitted is reused, not recomputed", { timeout: 60_000 }, async () => {
  const fixture = await openRaw("mem07-projection-window-");
  try {
    const prepared = await fixture.integration.prepareRequest({ requestId: "req-window", text: "later" }, context);
    assert.equal(prepared.kind, "new");
    const before = await allEntries(fixture.harness, fixture.root);
    const projections = before.filter((entry) => entry.kind === "personal.cycle");
    assert.equal(projections.length, 1);
    const projectionId = projections[0]!.id;

    // Restart before the input was ever submitted: the committed projection must be reused.
    await closeRaw(fixture);
    const reopened = await openRaw("mem07-projection-window-", { dataDir: fixture.directory });
    fixture.harness = reopened.harness;
    fixture.root = reopened.root;
    const again = await reopened.integration.prepareRequest({ requestId: "req-window", text: "later" }, context);
    assert.deepEqual(again, { kind: "new", action: "reuse-projection" });
    const after = await allEntries(reopened.harness, reopened.root);
    assert.deepEqual(
      after.filter((entry) => entry.kind === "personal.cycle").map((entry) => entry.id),
      [projectionId],
      "no second projection and no recomputed bytes",
    );
    const submission = await reopened.root.submit({ type: "input", content: "later", requestId: "req-window" }, context);
    reopened.faux.setResponses([(transcript) => {
      assert.ok(transcriptText(transcript.messages).includes("<cycle-snapshot>"), "the reused projection is in the first request");
      return fauxAssistantMessage("done");
    }]);
    assert.equal((await submission.wait(context)).status, "done");
    await reopened.integration.afterRequest("req-window", context);
    assert.equal(await readCompactionTurnCount(reopened.harness, reopened.root.id, context), 1);
    await disposeRaw(reopened);
  } finally {
    await disposeRaw(fixture);
  }
});

// ---------------------------------------------------------------------------
// 07-B: every first model call of a cycle carries A and the necessary working
// ---------------------------------------------------------------------------

async function seedWorking(dataDir: string): Promise<void> {
  const harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, "agent.sqlite")), {
    models: createModels(),
    registry: createToolRegistry(),
  }, context);
  try {
    const root = await harness.root(context);
    const evidence = await harness.commit(
      async (tx) => (await tx.appendEntry(root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: [{ type: "text", text: "Plan the release." }], timestamp: Date.now() }],
      })).id,
      context,
    );
    await applyWorkingUpdate(harness, {
      conversationId: root.id,
      operationId: "seed-1",
      expectedRevision: 1,
      evidence: [evidence],
      changes: [{
        op: "task.set",
        task: {
          status: "active", goal: "Ship the release", scope: null, constraints: ["No downtime"],
          progress: [], blockers: [], nextStep: "Tag v1", notes: null,
        },
      }],
      now: Date.now(),
    }, context);
  } finally {
    await harness.close(context);
  }
}

test("07-B: new, follow-up, restarted and post-reset first calls all carry A and working", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mem07-first-calls-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    await seedWorking(directory);

    const first = modelFixture();
    first.faux.setResponses([(transcript) => {
      const text = transcriptText(transcript.messages);
      assert.ok(text.includes("personal assistant"), "block A (instructions) is present");
      assert.ok(text.includes("<cycle-snapshot>"), "the first call carries block B");
      assert.ok(text.includes("Ship the release"), "B carries the necessary working baseline");
      return fauxAssistantMessage("planned");
    }]);
    app = await openAgent(appConfig(directory), first.models);
    assert.equal(await app.reply(request("1", "How is the release going?"), running), "planned");
    await app.close();
    app = undefined;

    // A tool follow-up inside one request still sees A and B on its later model call.
    const second = modelFixture();
    second.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("current_time", {}, { id: "clock" }), { stopReason: "toolUse" }),
      (transcript) => {
        const text = transcriptText(transcript.messages);
        assert.ok(text.includes("personal assistant"), "the follow-up call keeps block A");
        assert.ok(text.includes("<cycle-snapshot>"), "the follow-up call keeps block B");
        return fauxAssistantMessage("on track");
      },
    ]);
    app = await openAgent(appConfig(directory), second.models);
    assert.equal(await app.reply(request("2", "And now?"), running), "on track");

    // Explicit reset: the next request's first call carries a new B behind the reset.
    await app.reset();
    second.faux.setResponses([(transcript) => {
      const text = transcriptText(transcript.messages);
      assert.ok(text.includes("<cycle-snapshot>"), "the post-reset first call carries a new B");
      assert.ok(text.includes("Ship the release"), "the post-reset B still carries the working baseline");
      return fauxAssistantMessage("after reset");
    }]);
    assert.equal(await app.reply(request("3", "Fresh start, same task"), running), "after reset");
    await app.close();
    app = undefined;

    await inspectDatabase(directory, async (harness, root) => {
      const entries = await allEntries(harness, root);
      const resetIndex = entries.findIndex((entry) => entry.kind === "pi.reset");
      assert.ok(resetIndex >= 0, "a reset entry exists");
      const cycleAfterReset = entries.slice(resetIndex + 1).find((entry) => entry.kind === "personal.cycle");
      assert.ok(cycleAfterReset, "a new boundary projection follows the reset");
      // Working never changed after the seed, and B already carried it: no working re-projection
      // was ever needed, and nothing reloaded it per request (07-C dedupe at the context layer).
      assert.equal(entries.filter((entry) => entry.kind === "personal.context.projection").length, 0);
    });

    // Restart recovery: the first call after reopening still carries A and B from durable records.
    const third = modelFixture();
    third.faux.setResponses([(transcript) => {
      const text = transcriptText(transcript.messages);
      assert.ok(text.includes("personal assistant"));
      assert.ok(text.includes("<cycle-snapshot>"), "B survives the restart as a durable entry");
      return fauxAssistantMessage("recovered");
    }]);
    app = await openAgent(appConfig(directory), third.models);
    assert.equal(await app.reply(request("4", "Still there?"), running), "recovered");
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

// ---------------------------------------------------------------------------
// Facts change with nothing to summarize: the cycle restarts instead of failing
// ---------------------------------------------------------------------------

test("07-B/11: an instructions change ends the cycle explicitly and the next call carries the new B", { timeout: 60_000 }, async () => {
  const fixture = await openRaw("mem07-facts-", { instructions: "RULES V1" });
  try {
    fixture.faux.setResponses([fauxAssistantMessage("v1 answer")]);
    await driveRequest(fixture, "f-1", "hello");
    await closeRaw(fixture);

    const reopened = await openRaw("mem07-facts-", { dataDir: fixture.directory, instructions: "RULES V2" });
    reopened.faux.setResponses([(transcript) => {
      assert.ok(transcriptText(transcript.messages).includes("<cycle-snapshot>"), "the new cycle's B is in the first call");
      return fauxAssistantMessage("v2 answer");
    }]);
    await driveRequest(reopened, "f-2", "hello again");
    assert.ok(
      reopened.logs.some((event) => event.event === "memory.prepare" && event.action === "facts-restart"),
      "the cycle restart is recorded, not silent",
    );
    const entries = await allEntries(reopened.harness, reopened.root);
    const resetIndex = entries.findIndex((entry) => entry.kind === "pi.reset");
    assert.ok(resetIndex >= 0, "the old cycle ended with a reset");
    const cycle = entries.slice(resetIndex + 1).find((entry) => entry.kind === "personal.cycle");
    assert.ok(cycle, "a boundary projection follows the reset");
    const snapshot = snapshotOfProjection(cycle.data);
    const expected = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update("RULES V2").digest("hex").slice(0, 32));
    assert.equal(snapshot?.facts.instructionsDigest, expected, "the new B is built from the new facts");
    await disposeRaw(reopened);
  } finally {
    await disposeRaw(fixture);
  }
});

// ---------------------------------------------------------------------------
// 07-E: upgrade from a pre-MEM-07 database without backfill or data loss
// ---------------------------------------------------------------------------

test("07-E: upgrade keeps the native summary, MEMORY.md and the unfinished request", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mem07-upgrade-"));
  const workspace = join(directory, "workspace");
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "MEMORY.md"), "Legacy fact: green tea.\n");

    // Build the legacy database with no memory extensions at all, a native compaction, and a
    // request left unfinished by closing the harness mid-generation.
    const legacyFaux = fauxProvider({
      provider: "openai",
      models: [{ id: "faux-1", contextWindow: 1200, maxTokens: 512 }],
    });
    const legacyModels = createModels();
    legacyModels.setProvider(legacyFaux.provider);
    const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
      models: legacyModels,
      registry: createToolRegistry(),
      settings: { toolExecution: "sequential", compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 300, backgroundTokens: 0 } },
    }, context);
    const root = await harness.root(context, {
      agent: { model: { provider: "openai", modelId: "faux-1" }, instructions: "legacy rules" },
    });
    harness.resume();
    legacyFaux.setResponses([
      fauxAssistantMessage("Noted the festival."),
      fauxAssistantMessage("Native summary of the festival planning."),
    ]);
    const first = await root.submit({ type: "input", content: "festival ".repeat(200), requestId: "legacy-1" }, context);
    assert.equal((await first.wait(context)).status, "done");
    const compactTask = await root.compact(undefined, context);
    await until(async () => (await harness.getTask(compactTask, context))?.state.status === "terminal");
    await until(async () => (await root.context(context)).head?.kind === "pi.compaction");
    const started = Promise.withResolvers<void>();
    legacyFaux.setResponses([async (_transcript, options) => {
      started.resolve();
      await Promise.race([
        new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true })),
        delay(5_000),
      ]);
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    const unfinished = await root.submit({ type: "input", content: "an unfinished question", requestId: "legacy-open" }, context);
    void unfinished;
    await started.promise;
    await harness.close(context);

    // The upgrade itself: opening the current application over the legacy directory.
    const upgraded = modelFixture();
    upgraded.faux.setResponses([(transcript) => {
      assert.ok(transcriptText(transcript.messages).includes("an unfinished question"), "the recovered request keeps its original input");
      return fauxAssistantMessage("Recovered answer.");
    }]);
    app = await openAgent(appConfig(directory), upgraded.models);
    assert.equal(
      await app.reply({ requestId: "legacy-open", conversationId: "telegram:test", senderId: "1", text: "an unfinished question" }, running),
      "Recovered answer.",
      "the unfinished request completes after the upgrade, with its original input",
    );
    await app.close();
    app = undefined;

    assert.equal(await readFile(join(workspace, "MEMORY.md"), "utf8"), "Legacy fact: green tea.\n", "MEMORY.md is untouched");

    await inspectDatabase(directory, async (inspectHarness, inspectRoot) => {
      const entries = await allEntries(inspectHarness, inspectRoot);
      const native = entries.find((entry) => entry.kind === "pi.compaction");
      assert.ok(native, "the native compaction entry survives");
      const { publishedSnapshot } = await import("../src/memory/compaction.js");
      assert.equal(publishedSnapshot(native), undefined, "the native summary stays on the narrative compatibility path");
      assert.equal(
        entries.some((entry) => entry.kind === "personal.archive"),
        false,
        "the retired archive writes no state into an upgraded database",
      );
    });
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

// ---------------------------------------------------------------------------
// 07-F: closing stops memory work and preserves recovery state
// ---------------------------------------------------------------------------

test("07-F: close stops new memory work; reopening resumes from the preserved state", { timeout: 60_000 }, async () => {
  const fixture = await openRaw("mem07-close-");
  try {
    fixture.faux.setResponses([fauxAssistantMessage("one")]);
    await driveRequest(fixture, "c-1", "hello");
    fixture.integration.close();
    await assert.rejects(
      fixture.integration.prepareRequest({ requestId: "c-2", text: "too late" }, context),
      (error: unknown) => (error as { code?: string }).code === "MEMORY_CANCELLED",
    );
    await closeRaw(fixture);

    const reopened = await openRaw("mem07-close-", { dataDir: fixture.directory });
    assert.equal(await readCompactionTurnCount(reopened.harness, reopened.root.id, context), 1, "the turn counter survived the close");
    reopened.faux.setResponses([fauxAssistantMessage("two")]);
    await driveRequest(reopened, "c-2", "too late");
    assert.equal(await readCompactionTurnCount(reopened.harness, reopened.root.id, context), 2);
    await disposeRaw(reopened);
  } finally {
    await disposeRaw(fixture);
  }
});

test("07-F/11: a plan-level refusal surfaces as a MEMORY_* error, never AGENT_SESSION_FAILED", { timeout: 60_000 }, async () => {
  // Block A measures ~430 tokens here; a 256-token instructions share refuses the request at
  // plan time. (The shipped instructions measure ~243 tokens, so this uses the raw fixture's
  // longer rules text to reach the same planner branch deterministically.)
  const fixture = await openRaw("mem07-plan-error-", {
    instructions: `RULES ${"detail ".repeat(200)}`,
    budget: { instructionsTokens: 256 },
  });
  try {
    await assert.rejects(
      fixture.integration.prepareRequest({ requestId: "p-1", text: "hello" }, context),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "MEMORY_BUDGET_EXCEEDED");
        const cause = (error as { cause?: { code?: string } }).cause;
        assert.equal(cause?.code, "budget-exceeded", "the frozen business code is preserved as the cause");
        return true;
      },
    );
    const submission = await fixture.harness.commit(
      async (tx) => tx.submissionByRequest(fixture.root.id, "p-1"),
      context,
    );
    assert.equal(submission, undefined, "a refused request is never admitted");
    assert.equal(fixture.faux.state.callCount, 0, "the refused request never reached the model");
  } finally {
    await disposeRaw(fixture);
  }
});

// ---------------------------------------------------------------------------
// 07-G: the composition boundaries hold in the source tree
// ---------------------------------------------------------------------------

test("07-G: agent.ts composes only through the integration entry; inbox/delivery/web stay memory-free", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (path: string) => readFile(join(root, path), "utf8");

  const agent = await read("src/agent.ts");
  const memoryImports = [...agent.matchAll(/from\s+"([^"]*memory[^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(memoryImports, ["./memory/integration.js"], "the application imports memory only through the composition entry");
  for (const forbidden of ["beforeCompact", "scanEntries", "evidenceThrough", "memory_search", "memory_read", "UsageDoc", "/dist/"]) {
    assert.ok(!agent.includes(forbidden), `agent.ts must not contain ${forbidden}`);
  }

  for (const path of ["src/inbox.ts", "src/deliveries.ts", "src/main.ts", "src/http/run-web.ts"]) {
    const source = await read(path);
    assert.ok(!/from\s+"[^"]*memory\//.test(source), `${path} must not import memory internals`);
  }

  const { stat } = await import("node:fs/promises");
  assert.ok((await stat(join(root, "src/memory/integration.ts"))).isFile(), "the composition entry exists");
});

// ---------------------------------------------------------------------------
// Wiring seams: counting -> evaluation -> native compaction -> switched head,
// all from durable facts at request boundaries
// ---------------------------------------------------------------------------

test("07 wiring: completed turns evaluate and compact; the switch becomes the head", { timeout: 120_000 }, async () => {
  const fixture = await openRaw("mem07-evaluation-", {
    budget: { evaluateAfterUserTurns: 2, recentVerbatimTokens: 512 },
  });
  try {
    const router = (transcript: { messages: readonly Message[] }) => {
      const all = JSON.stringify(transcript.messages);
      if (all.includes("context summarization assistant")) {
        return fauxAssistantMessage("The long inputs are preserved as project context.");
      }
      return fauxAssistantMessage("answer");
    };
    fixture.faux.setResponses(Array.from({ length: 64 }, () => router));
    const long = "lorem ipsum dolor sit amet ".repeat(80);

    await driveRequest(fixture, "w-1", long);
    await driveRequest(fixture, "w-2", long);
    assert.equal(await readCompactionTurnCount(fixture.harness, fixture.root.id, context), 2);

    // The evaluation at the second completion started a native compaction; the adapter's hook
    // built the new B and the switch becomes the active head without any test-side shortcut.
    await until(async () => (await fixture.root.context(context)).head?.kind === "pi.compaction", 60_000);
    assert.ok(
      fixture.logs.some((event) => event.event === "compaction.result" && (event.action === "succeeded" || event.action === "reused")),
      "the summary was produced by the registered adapter",
    );
    const usage = await fixture.harness.snapshot(UsageDoc, fixture.root.id, context);
    assert.ok((usage?.models["app/summary"]?.totalTokens ?? 0) > 0, "summary usage is accounted under the application key");

    // The next request boundary keeps working from that durable head, with no archive work.
    await driveRequest(fixture, "w-3", "short follow-up");
    assert.equal(await readCompactionTurnCount(fixture.harness, fixture.root.id, context), 3);
    const tasks = await fixture.harness.commit(
      async (tx) => (await tx.scanTasks({ conversationId: fixture.root.id }, 100)).items,
      context,
    );
    assert.equal(tasks.some((task) => task.kind === "personal.archive"), false, "no archive task exists");
  } finally {
    await disposeRaw(fixture);
  }
});

// ---------------------------------------------------------------------------
// An injected disabled memory section: the pre-MEM-07 application, unchanged. There is no
// environment switch; tests (and future embedders) inject `enabled: false` themselves.
// ---------------------------------------------------------------------------

test("07-F: an injected disabled memory section keeps the previous registry, settings and request path", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mem07-disabled-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const { faux, models } = modelFixture();
    faux.setResponses([(transcript) => {
      const names = transcript.messages.flatMap((message) =>
        message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []);
      assert.ok(!names.includes("working_update"), "no memory tools are registered");
      return fauxAssistantMessage("plain answer");
    }]);
    app = await openAgent(withMemoryOff(appConfig(directory)), models);
    assert.equal(await app.reply(request("1", "hello"), running), "plain answer");
    await app.close();
    app = undefined;
    await inspectDatabase(directory, async (harness, root) => {
      const entries = await allEntries(harness, root);
      assert.equal(entries.filter((entry) => entry.kind === "personal.cycle").length, 0, "no projection was written");
      assert.equal(entries.some((entry) => entry.kind === "personal.archive"), false, "no archive state exists");
    });
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
