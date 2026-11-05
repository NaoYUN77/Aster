// Proactive Loop V1 application tests. Each run uses the real `openAgent` composition, a faux
// provider, and a fake DeepSeek Web endpoint; no network and no real model.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgent } from "../src/agent.js";
import { readConfig, readMemoryConfig } from "../src/config.js";
import type { WorkingChangeDraft } from "../src/memory/contracts.js";
import { applyWorkingUpdate, readWorking } from "../src/memory/working.js";
import type { TextRequest } from "../src/messages.js";
import { ProactiveScheduler, ProactiveStore, type ProactiveConfig, type ProactiveDeliveryState } from "../src/proactive.js";
import { createToolRegistry } from "../src/tools.js";

const context = BACKGROUND_CONTEXT;
const running = new AbortController().signal;
const CLOCK = () => new Date("2026-11-05T08:00:00.000Z");

type AppConfig = ReturnType<typeof readConfig>;

function appConfig(dataDir: string, env: NodeJS.ProcessEnv = {}): AppConfig {
  const full = {
    TELEGRAM_BOT_TOKEN: "offline-test",
    TELEGRAM_OWNER_ID: "1",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: dataDir,
    MEMORY_ENABLED: "0",
    ...env,
  };
  return { ...readConfig(full), memory: readMemoryConfig(full) } as AppConfig;
}

function proactiveEnv(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PROACTIVE_ENABLED: "1",
    DEEPSEEK_WEB_API_KEY: "web-key",
    PROACTIVE_DAILY_AT: "23:59",
    PROACTIVE_TIMEZONE: "UTC",
    ...env,
  };
}

function modelFixture() {
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

function request(id: string, text: string): TextRequest {
  return { requestId: `telegram:test:${id}`, conversationId: "telegram:test", senderId: "1", text };
}

/** Text of every message, without the JSON escaping that would hide quotes from assertions. */
function transcriptText(messages: readonly Message[]): string {
  return messages.flatMap((message): string[] => {
    const parts: string[] = [];
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    // Rendered prompt sections live beside the (empty) system content, not inside it.
    const sections = (message as { sections?: unknown }).sections;
    if (sections !== null && typeof sections === "object") {
      for (const value of Object.values(sections)) if (typeof value === "string") parts.push(value);
    }
    return parts;
  }).join("\n");
}

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a proactive condition");
    await delay(20);
  }
}

async function seedMemory(dataDir: string, options: { goal?: string; preference?: string } = {}): Promise<void> {
  const harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, "agent.sqlite")), {
    models: createModels(),
    registry: createToolRegistry(),
  }, context);
  try {
    const root = await harness.root(context);
    const evidence = await harness.commit(
      async (tx) => (await tx.appendEntry(root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: [{ type: "text", text: "seed memory" }], timestamp: Date.now() }],
      })).id,
      context,
    );
    const changes: WorkingChangeDraft[] = [];
    if (options.goal !== undefined) {
      changes.push({
        op: "task.set",
        task: {
          status: "active", goal: options.goal, scope: null, constraints: [], progress: [],
          blockers: [], nextStep: null, notes: null,
        },
      });
    }
    if (options.preference !== undefined) {
      changes.push({
        op: "preference.put",
        preference: { id: "pref-1", text: options.preference, scope: "global", source: evidence, expiresAt: null },
      });
    }
    assert.ok(changes.length > 0);
    await applyWorkingUpdate(harness, {
      conversationId: root.id,
      operationId: "seed-1",
      expectedRevision: 1,
      evidence: [evidence],
      changes,
      now: Date.now(),
    }, context);
  } finally {
    await harness.close(context);
  }
}

async function updateGoal(dataDir: string, goal: string): Promise<void> {
  const harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, "agent.sqlite")), {
    models: createModels(),
    registry: createToolRegistry(),
  }, context);
  try {
    const root = await harness.root(context);
    const current = await readWorking(harness, root.id, context);
    const evidence = await harness.commit(
      async (tx) => (await tx.appendEntry(root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: [{ type: "text", text: "the goal changed" }], timestamp: Date.now() }],
      })).id,
      context,
    );
    await applyWorkingUpdate(harness, {
      conversationId: root.id,
      operationId: "seed-2",
      expectedRevision: current.revision,
      evidence: [evidence],
      changes: [{
        op: "task.set",
        task: {
          status: "active", goal, scope: null, constraints: [], progress: [],
          blockers: [], nextStep: null, notes: null,
        },
      }],
      now: Date.now(),
    }, context);
  } finally {
    await harness.close(context);
  }
}

type WebResult = { readonly title: string; readonly url: string };

/** The only network in these tests: a deterministic stand-in for the DeepSeek Web endpoints. */
function webFixture(results: readonly WebResult[]) {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.deepseek.com/v1/tools/search") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
      calls.push(`search:${body.query ?? ""}`);
      return Response.json({
        results: results.map((result) => ({
          title: result.title,
          url: result.url,
          snippet: "A snippet",
          summary: "A summary",
          site_name: "Example",
          date: "2026-11-05T00:00:00Z",
        })),
      });
    }
    if (url === "https://api.deepseek.com/v1/tools/fetch") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { url?: string };
      calls.push(`fetch:${body.url ?? ""}`);
      return Response.json({ title: "Fetched page", content: "Fetched content" });
    }
    throw new Error(`Unexpected web fetch ${url}`);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function scheduler(
  store: ProactiveStore,
  config: ProactiveConfig,
  app: { run(runId: number, signal: AbortSignal): Promise<void> },
  inbox: Map<string, ProactiveDeliveryState>,
) {
  return new ProactiveScheduler({
    store,
    config,
    runner: app,
    inbox: { deliveryStatus: (requestId) => inbox.get(requestId) ?? "missing" },
    now: CLOCK,
    log: () => {},
  });
}

function openStoredDirectory(dataDir: string): Promise<Harness> {
  return openNodeSqliteStorage(join(dataDir, "agent.sqlite")).then((storage) => Harness.open(storage, {
    models: createModels(),
    registry: createToolRegistry(),
  }, context));
}

test("a run reads bounded memory, uses web_search and hands a verified decision to the host", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-proactive-run-"));
  const marker = "Verified-9c21";
  const web = webFixture([{ title: "TypeScript 7", url: "https://example.com/ts7" }]);
  const store = new ProactiveStore(join(directory, "proactive.sqlite"), { now: CLOCK });
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    await seedMemory(directory, { goal: "Ship the proactive loop", preference: "Prefers TypeScript release notes" });
    const config = appConfig(directory, proactiveEnv());
    const { faux, models } = modelFixture();
    faux.setResponses([
      (transcript) => {
        const text = transcriptText(transcript.messages);
        assert.match(text, /background information scout/, "the background conversation uses its own instructions");
        assert.match(text, /Prefers TypeScript release notes/, "the recorded preference is in the snapshot");
        assert.match(text, /"revision":2/, "the snapshot carries the memory revision");
        assert.match(text, /"source":\{"conversationId":\d+/, "the preference keeps its source");
        assert.match(text, /Ship the proactive loop/, "the current task goal is in the snapshot");
        assert.doesNotMatch(text, /personal assistant/, "the main conversation instructions are not copied");
        return fauxAssistantMessage(fauxToolCall("web_search", { query: "typescript release" }), { stopReason: "toolUse" });
      },
      (transcript) => {
        const text = transcriptText(transcript.messages);
        assert.match(text, /"ok":true/, "the decision follows a real tool result");
        return fauxAssistantMessage(JSON.stringify({
          decision: "notify",
          items: [{
            title: `TypeScript ${marker}`,
            url: "https://example.com/ts7",
            summary: "TypeScript 7 was released",
            relevance: "Matches the owner's TypeScript preference",
          }],
          reason: "A new release matters to the owner",
        }));
      },
      fauxAssistantMessage("main reply works"),
    ]);
    const delivered: { requestId: string; text: string }[] = [];
    const inbox = new Map<string, ProactiveDeliveryState>();
    app = await openAgent(config, models, undefined, {
      proactive: {
        store,
        enqueue: (requestId, text) => {
          delivered.push({ requestId, text });
          inbox.set(requestId, "ready");
        },
      },
      webFetch: web.fetch,
      toolReviewLog: () => {},
    });
    const { run } = store.enqueueTrigger({ kind: "manual", timezone: "UTC" });
    const due = scheduler(store, config.proactive!, app.proactive!, inbox);
    await due.runDue();

    const decided = store.get(run.id);
    assert.equal(decided?.status, "delivering", JSON.stringify(decided));
    assert.equal(decided?.decision, "notify");
    assert.equal(decided?.errorCode, null);
    assert.equal(decided?.memoryRevision, 2);
    assert.equal(decided?.toolCalls, 1);
    assert.deepEqual(delivered.map(({ requestId }) => requestId), [`proactive:${run.id}`]);
    assert.match(delivered[0]?.text ?? "", new RegExp(marker));
    assert.match(delivered[0]?.text ?? "", /https:\/\/example\.com\/ts7/);
    assert.deepEqual(web.calls, ["search:typescript release"], "discovery goes through the existing web tool");
    assert.notEqual(decided?.conversationId, null);
    assert.notEqual(decided?.submissionId, null);

    inbox.set(`proactive:${run.id}`, "sent");
    await due.runDue();
    assert.equal(store.get(run.id)?.status, "delivered");

    assert.equal(await app.reply(request("main-1", "hello"), running), "main reply works");
  } finally {
    await app?.close();
  }
  let rootId: number | undefined;
  try {
    const harness = await openStoredDirectory(directory);
    try {
      const root = await harness.root(context);
      rootId = Number(root.id);
      const rootText = JSON.stringify((await root.context(context)).messages);
      assert.match(rootText, /hello/, "the main conversation served its own request");
      assert.doesNotMatch(rootText, /background information scout/, "no proactive instructions leaked into the main conversation");
      assert.doesNotMatch(rootText, new RegExp(marker), "no proactive output leaked into the main conversation");
    } finally {
      await harness.close(context);
    }
    const db = new DatabaseSync(join(directory, "agent.sqlite"), { readOnly: true });
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n, 2);
      const storedRun = store.get(runIdOf(store));
      assert.ok(storedRun?.conversationId);
      const submission = db.prepare("SELECT conversation_id, request_id, status FROM submissions WHERE conversation_id = ?")
        .get(Number(storedRun.conversationId)) as { conversation_id: number; request_id: string; status: string } | undefined;
      assert.ok(submission, "the run used a native pi-durable Submission");
      assert.equal(submission.status, "done");
      assert.equal(JSON.parse(submission.request_id), `proactive:${storedRun.id}`, "the Submission carries the run's request ID");
      assert.notEqual(submission.conversation_id, rootId, "the Submission belongs to the background conversation, not the main one");
    } finally {
      db.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function runIdOf(store: ProactiveStore): number {
  const [run] = store.list();
  assert.ok(run !== undefined);
  return run.id;
}

test("a later run re-reads the new memory revision and skips URLs already delivered", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-proactive-dedupe-"));
  const web = webFixture([{ title: "TypeScript 7", url: "https://example.com/ts7" }]);
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  let store = new ProactiveStore(join(directory, "proactive.sqlite"), { now: CLOCK });
  const delivered: string[] = [];
  try {
    await seedMemory(directory, { goal: "First goal" });
    const firstConfig = appConfig(directory, proactiveEnv());
    const first = modelFixture();
    first.faux.setResponses([
      (transcript) => {
        assert.match(transcriptText(transcript.messages), /First goal/);
        return fauxAssistantMessage(fauxToolCall("web_search", { query: "first" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(JSON.stringify({
        decision: "notify",
        items: [{ title: "Release", url: "https://example.com/ts7", summary: "Released", relevance: "Relevant" }],
        reason: "First delivery",
      })),
    ]);
    app = await openAgent(firstConfig, first.models, undefined, {
      proactive: { store, enqueue: (requestId, text) => { delivered.push(requestId); assert.ok(text.length > 0); } },
      webFetch: web.fetch,
      toolReviewLog: () => {},
    });
    store.enqueueTrigger({ kind: "manual", timezone: "UTC" });
    await scheduler(store, firstConfig.proactive!, app.proactive!, new Map()).runDue();
    assert.equal(store.list()[0]?.status, "delivering");
    await app.close();
    app = undefined;
    store.close();

    await updateGoal(directory, "Second goal");
    const secondConfig = appConfig(directory, proactiveEnv({ PROACTIVE_MAX_PER_DAY: "10" }));
    store = new ProactiveStore(join(directory, "proactive.sqlite"), { limits: secondConfig.proactive, now: CLOCK });
    const second = modelFixture();
    second.faux.setResponses([
      (transcript) => {
        const text = transcriptText(transcript.messages);
        assert.match(text, /Second goal/, "the new task goal is read, not the first one");
        assert.doesNotMatch(text, /First goal/);
        assert.match(text, /"revision":3/, "the second run sees the newer memory revision");
        assert.match(text, /Previously delivered URLs:\n- https:\/\/example\.com\/ts7/);
        return fauxAssistantMessage(fauxToolCall("web_search", { query: "second" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(JSON.stringify({
        decision: "notify",
        items: [{ title: "Release again", url: "https://example.com/ts7", summary: "Released", relevance: "Relevant" }],
        reason: "Same URL",
      })),
    ]);
    app = await openAgent(secondConfig, second.models, undefined, {
      proactive: { store, enqueue: (requestId) => delivered.push(requestId) },
      webFetch: web.fetch,
      toolReviewLog: () => {},
    });
    const { run } = store.enqueueTrigger({ kind: "manual", timezone: "UTC" });
    await scheduler(store, secondConfig.proactive!, app.proactive!, new Map()).runDue();
    const skipped = store.get(run.id);
    assert.equal(skipped?.status, "skipped");
    assert.equal(skipped?.reason, "no-new-items");
    assert.equal(delivered.length, 1, "the previously delivered URL is not sent again");
  } finally {
    await app?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("empty memory stays empty in the prompt and a skip decision never enqueues delivery", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-proactive-skip-"));
  const web = webFixture([{ title: "Something", url: "https://example.com/maybe" }]);
  const store = new ProactiveStore(join(directory, "proactive.sqlite"), { now: CLOCK });
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  const delivered: string[] = [];
  try {
    const config = appConfig(directory, proactiveEnv());
    const { faux, models } = modelFixture();
    faux.setResponses([
      (transcript) => {
        const text = transcriptText(transcript.messages);
        assert.match(text, /"preferences":\[\]/);
        assert.match(text, /"profile":\[\]/);
        assert.match(text, /"task":\{"status":"none"\}/);
        assert.doesNotMatch(text, /pref-/, "no preference id is invented");
        return fauxAssistantMessage(fauxToolCall("web_search", { query: "unrelated" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(JSON.stringify({ decision: "skip", reason: "Nothing matches the owner's recorded interests" })),
    ]);
    app = await openAgent(config, models, undefined, {
      proactive: { store, enqueue: (requestId) => delivered.push(requestId) },
      webFetch: web.fetch,
      toolReviewLog: () => {},
    });
    const { run } = store.enqueueTrigger({ kind: "manual", timezone: "UTC" });
    await scheduler(store, config.proactive!, app.proactive!, new Map()).runDue();

    const skipped = store.get(run.id);
    assert.equal(skipped?.status, "skipped");
    assert.equal(skipped?.decision, "skip");
    assert.equal(skipped?.reason, "Nothing matches the owner's recorded interests");
    assert.equal(skipped?.completedAt !== null, true);
    assert.deepEqual(delivered, []);
  } finally {
    await app?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a background run does not block the main conversation's reply path", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-proactive-concurrent-"));
  const web = webFixture([{ title: "Background", url: "https://example.com/background" }]);
  const store = new ProactiveStore(join(directory, "proactive.sqlite"), { now: CLOCK });
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const config = appConfig(directory, proactiveEnv());
    const { faux, models } = modelFixture();
    const factory: FauxResponseFactory = async (transcript) => {
      const text = transcriptText(transcript.messages);
      if (!text.includes("background information scout")) return fauxAssistantMessage("main during background");
      if (!text.includes('"ok":true')) {
        return fauxAssistantMessage(fauxToolCall("web_search", { query: "background" }), { stopReason: "toolUse" });
      }
      await gate;
      return fauxAssistantMessage(JSON.stringify({ decision: "skip", reason: "Nothing urgent" }));
    };
    faux.setResponses([factory, factory, factory, factory]);
    app = await openAgent(config, models, undefined, {
      proactive: { store, enqueue: () => assert.fail("a skip must not enqueue a delivery") },
      webFetch: web.fetch,
      toolReviewLog: () => {},
    });
    const { run } = store.enqueueTrigger({ kind: "manual", timezone: "UTC" });
    const backgroundRun = scheduler(store, config.proactive!, app.proactive!, new Map()).runDue();
    await until(() => store.get(run.id)?.status === "running" && store.observedUrls(run.id).length > 0);

    const reply = await app.reply(request("main-2", "are you there?"), running);
    assert.equal(reply, "main during background");
    assert.equal(store.get(run.id)?.status, "running", "the main reply completed while the background run was still waiting");

    release();
    await backgroundRun;
    assert.equal(store.get(run.id)?.status, "skipped");
  } finally {
    release();
    await app?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a decided run is re-enqueued on recovery without executing the model again", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-proactive-recover-decided-"));
  const store = new ProactiveStore(join(directory, "proactive.sqlite"), { now: CLOCK });
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  const delivered: string[] = [];
  try {
    const config = appConfig(directory, proactiveEnv());
    const { run } = store.enqueueTrigger({ kind: "manual", timezone: "UTC" });
    store.claimNext();
    const decided = store.acceptNotify(run.id, {
      items: [{ title: "Saved decision", url: "https://example.com/saved", summary: "Summary", relevance: "Relevant" }],
      reason: "Already persisted",
      toolCalls: 1,
      tokens: 50,
    });
    assert.equal(decided.status, "decided");

    const { faux, models } = modelFixture();
    faux.setResponses([]);
    app = await openAgent(config, models, undefined, {
      proactive: { store, enqueue: (requestId) => delivered.push(requestId) },
      webFetch: webFixture([]).fetch,
      toolReviewLog: () => {},
    });
    store.recover();
    await app.proactive!.recover(running);

    assert.deepEqual(delivered, [`proactive:${run.id}`]);
    assert.equal(store.get(run.id)?.status, "delivering");
    assert.equal(faux.state.callCount, 0, "recovery only re-enqueued the saved delivery");
  } finally {
    await app?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const loseSubmissionId of [false, true]) {
test(`a durable Submission is resumed after restart (local ID ${loseSubmissionId ? "missing" : "saved"})`, { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-proactive-resume-"));
  const web = webFixture([]);
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  let store = new ProactiveStore(join(directory, "proactive.sqlite"), { now: CLOCK });
  try {
    const config = appConfig(directory, proactiveEnv());
    const first = modelFixture();
    first.faux.setResponses([fauxAssistantMessage(JSON.stringify({ decision: "skip", reason: "No new information" }))]);
    app = await openAgent(config, first.models, undefined, {
      proactive: { store, enqueue: () => assert.fail("skip must not deliver") },
      webFetch: web.fetch,
      toolReviewLog: () => {},
    });
    const { run } = store.enqueueTrigger({ kind: "manual", timezone: "UTC" });
    await scheduler(store, config.proactive!, app.proactive!, new Map()).runDue();
    const finished = store.get(run.id);
    assert.equal(finished?.status, "skipped");
    assert.notEqual(finished?.conversationId, null);
    assert.notEqual(finished?.submissionId, null);
    await app.close();
    app = undefined;
    store.close();

    // A crash after the Submission finished but before its answer was recorded leaves exactly
    // this shape: status running, decision empty, durable conversation and Submission present.
    const db = new DatabaseSync(join(directory, "proactive.sqlite"));
    try {
      db.prepare(`UPDATE proactive_runs SET status = 'running', decision = NULL, reason = NULL,
        itemsJson = NULL, decidedAt = NULL, completedAt = NULL WHERE id = ?`).run(run.id);
      if (loseSubmissionId) db.prepare("UPDATE proactive_runs SET submissionId = NULL WHERE id = ?").run(run.id);
    } finally {
      db.close();
    }
    store = new ProactiveStore(join(directory, "proactive.sqlite"), { now: CLOCK });
    const second = modelFixture();
    second.faux.setResponses([]);
    app = await openAgent(config, second.models, undefined, {
      proactive: { store, enqueue: () => assert.fail("the saved answer is a skip") },
      webFetch: webFixture([]).fetch,
      toolReviewLog: () => {},
    });
    store.recover();
    assert.equal(store.get(run.id)?.status, "running", "a Submission identity is kept for resumption");
    await app.proactive!.recover(running);

    const resumed = store.get(run.id);
    assert.equal(resumed?.status, "skipped");
    assert.equal(resumed?.reason, "No new information");
    assert.equal(resumed?.conversationId, finished.conversationId, "the same durable conversation is reused");
    assert.equal(resumed?.submissionId, finished.submissionId);
    assert.equal(second.faux.state.callCount, 0, "the finished Submission is read, not re-generated");
  } finally {
    await app?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
}

test("an over-budget final decision is failed before delivery and does not stop the main chat", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-proactive-token-budget-"));
  const store = new ProactiveStore(join(directory, "proactive.sqlite"), { now: CLOCK });
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const config = appConfig(directory, proactiveEnv({ PROACTIVE_MAX_TOKENS: "1000" }));
    const { faux, models } = modelFixture();
    const decision = fauxAssistantMessage(JSON.stringify({ decision: "skip", reason: "Over budget" }));
    faux.setResponses([
      { ...decision, usage: { ...decision.usage, input: 1200, totalTokens: 1200 } },
      fauxAssistantMessage("main remains available"),
    ]);
    app = await openAgent(config, models, undefined, {
      proactive: { store, enqueue: () => assert.fail("over-budget decisions cannot deliver") },
      webFetch: webFixture([]).fetch,
      toolReviewLog: () => {},
    });
    const { run } = store.enqueueTrigger({ kind: "manual", timezone: "UTC" });
    await scheduler(store, config.proactive!, app.proactive!, new Map()).runDue();
    assert.equal(store.get(run.id)?.status, "failed");
    assert.equal(store.get(run.id)?.errorCode, "PROACTIVE_BUDGET_TOKENS");
    assert.equal(await app.reply(request("after-budget", "hello"), running), "main remains available");
  } finally {
    await app?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
