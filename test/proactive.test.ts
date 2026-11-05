// Proactive Loop V1 domain tests: configuration, strict decision parsing, bounded context,
// durable state transitions, recovery, and the in-process scheduler. No model and no network.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Value } from "typebox/value";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { ConfigurationError, readConfig, readProactiveConfig } from "../src/config.js";
import { WorkingStateSchema, type WorkingState } from "../src/memory/contracts.js";
import {
  buildProactiveContext,
  normalizeProactiveUrl,
  parseProactiveDecision,
  PROACTIVE_LIMITS,
  ProactiveScheduler,
  ProactiveStore,
  proactiveMessage,
  type ProactiveConfig,
  type ProactiveDeliveryState,
} from "../src/proactive.js";

const FIXED_NOW = new Date("2026-11-05T08:00:00.000Z");

function fixedClock(start = FIXED_NOW) {
  const clock = { time: new Date(start) };
  return { clock, now: () => clock.time };
}

async function withStore(
  run: (store: ProactiveStore, directory: string) => Promise<void> | void,
  options: { limits?: ProactiveStore["limits"]; now?: () => Date; timezone?: string } = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "aster-proactive-"));
  const store = new ProactiveStore(join(directory, "proactive.sqlite"), options);
  try {
    await run(store, directory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function item(url = "https://example.com/a", title = "A") {
  return { title, url, summary: "Summary", relevance: "Relevant" };
}

function accepted(store: ProactiveStore, runId: number, urls: string[] = ["https://example.com/a"]) {
  return store.acceptNotify(runId, {
    items: urls.map((url, index) => item(url, `Item ${index + 1}`)),
    reason: "Worth telling",
    toolCalls: 2,
    tokens: 100,
  });
}

let claimSequence = 0;

/** Enqueue a manual trigger and claim it, the way the scheduler does before a run. */
function claim(store: ProactiveStore) {
  store.enqueueTrigger({ kind: "manual", triggerKey: `test:${++claimSequence}`, timezone: "UTC" });
  const run = store.claimNext();
  assert.ok(run !== undefined, "the queued run was claimable");
  return run;
}

test("proactive config defaults off and validates every bound", () => {
  assert.equal(readProactiveConfig({}).enabled, false);
  assert.deepEqual(readProactiveConfig({}), { enabled: false, ...PROACTIVE_LIMITS, dailyAt: "09:00", timezone: "UTC" });
  assert.equal(readProactiveConfig({ PROACTIVE_ENABLED: "1" }).enabled, true);
  assert.equal(readProactiveConfig({ PROACTIVE_ENABLED: "0" }).enabled, false);
  assert.equal(readProactiveConfig({ PROACTIVE_TIMEZONE: "Asia/Shanghai" }).timezone, "Asia/Shanghai");
  assert.equal(readProactiveConfig({ MEMORY_TIMEZONE: "Asia/Shanghai" }).timezone, "Asia/Shanghai");
  assert.equal(readProactiveConfig({ PROACTIVE_DAILY_AT: "23:59" }).dailyAt, "23:59");
  assert.equal(readProactiveConfig({ PROACTIVE_MAX_PER_DAY: "10" }).maxPerDay, 10);

  assert.throws(() => readProactiveConfig({ PROACTIVE_ENABLED: "yes" }), ConfigurationError);
  assert.throws(() => readProactiveConfig({ PROACTIVE_DAILY_AT: "24:00" }), /PROACTIVE_DAILY_AT/);
  assert.throws(() => readProactiveConfig({ PROACTIVE_DAILY_AT: "9:00" }), /PROACTIVE_DAILY_AT/);
  assert.throws(() => readProactiveConfig({ PROACTIVE_TIMEZONE: "Mars/Olympus" }), /PROACTIVE_TIMEZONE/);
  for (const [key, value] of [
    ["PROACTIVE_MAX_PER_DAY", "0"],
    ["PROACTIVE_MAX_TOOL_CALLS", "101"],
    ["PROACTIVE_MAX_TOKENS", "999"],
    ["PROACTIVE_TIMEOUT_MS", "9999"],
    ["PROACTIVE_CONTEXT_MAX_CHARS", "999"],
    ["PROACTIVE_RECENT_DAYS", "31"],
  ] as const) {
    assert.throws(() => readProactiveConfig({ [key]: value }), new RegExp(key), `${key}=${value} is rejected`);
  }
});

test("enabling the loop without a web credential fails startup instead of degrading silently", () => {
  const base = {
    TELEGRAM_BOT_TOKEN: "offline-test",
    TELEGRAM_OWNER_ID: "1",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: "./data",
    PROACTIVE_ENABLED: "1",
  };
  assert.throws(() => readConfig(base), /DEEPSEEK_WEB_API_KEY/);
  assert.equal(readConfig({ ...base, DEEPSEEK_WEB_API_KEY: "web" }).proactive?.enabled, true);
});

test("decision parsing is strict and never repairs an invalid answer", () => {
  const notify = parseProactiveDecision(JSON.stringify({
    decision: "notify",
    items: [item()],
    reason: "New release",
  }));
  assert.equal(notify.ok, true);
  assert.deepEqual(notify.ok && notify.value, { decision: "notify", items: [item()], reason: "New release" });

  const fenced = parseProactiveDecision("```json\n" + JSON.stringify({ decision: "skip", reason: "Nothing new" }) + "\n```");
  assert.deepEqual(fenced, { ok: true, value: { decision: "skip", reason: "Nothing new" } });

  const invalid = [
    "",
    "I found something interesting.",
    "{not json}",
    "{}{}",
    JSON.stringify({ decision: "notify", items: [], reason: "empty" }),
    JSON.stringify({ decision: "notify", items: [item()] }),
    JSON.stringify({ decision: "notify", items: [item()], reason: "x", extra: true }),
    JSON.stringify({ decision: "skip" }),
    JSON.stringify({ decision: "skip", reason: "  " }),
    JSON.stringify({ decision: "notify", items: [{ ...item(), url: "" }], reason: "x" }),
    JSON.stringify({ decision: "notify", items: [{ ...item(), title: "x".repeat(201) }], reason: "x" }),
    JSON.stringify({ decision: "notify", items: [item(), item(), item(), item()], reason: "too many" }),
  ];
  for (const text of invalid) assert.equal(parseProactiveDecision(text).ok, false, text.slice(0, 80));
  assert.deepEqual(parseProactiveDecision("prefix " + JSON.stringify({ decision: "skip", reason: "x" })), {
    ok: false,
    code: "PROACTIVE_DECISION_INVALID_JSON",
  });
});

test("URLs are normalized, deduplicated by fragment, and restricted to public http(s)", () => {
  assert.deepEqual(normalizeProactiveUrl("https://Example.com/a?b=1#part"), {
    url: "https://example.com/a?b=1",
    key: "https://example.com/a?b=1",
  });
  assert.equal(normalizeProactiveUrl("http://example.com/")?.key, "http://example.com/");
  for (const value of ["", "relative/path", "ftp://example.com/a", "mailto:a@example.com", "https://user:pass@example.com/a", "javascript:alert(1)"]) {
    assert.equal(normalizeProactiveUrl(value), undefined, value);
  }
  assert.equal(normalizeProactiveUrl("https://example.com/a#one")?.key, normalizeProactiveUrl("https://example.com/a#two")?.key);
});

function workingState(overrides: Partial<WorkingState> = {}): WorkingState {
  return {
    version: 1,
    revision: 7,
    task: { status: "none" },
    preferences: [],
    profile: [],
    updatedAt: FIXED_NOW.getTime(),
    ...overrides,
  };
}

test("proactive context carries version, revision, active task and preference sources", () => {
  const state = workingState({
    revision: 7,
    task: {
      status: "active", goal: "Ship the loop", scope: "release", constraints: ["No downtime"],
      progress: [], blockers: [], nextStep: "Tag v1", notes: null,
      sources: [{ conversationId: 1 as ConversationId, entryId: 2 as EntryId }],
    },
    preferences: [
      {
        id: "pref-1", text: "Prefers TypeScript release notes", scope: "subscriptions",
        source: { conversationId: 1 as ConversationId, entryId: 3 as EntryId }, expiresAt: null,
      },
      {
        id: "pref-expired", text: "Expired preference", scope: "global",
        source: { conversationId: 1 as ConversationId, entryId: 4 as EntryId }, expiresAt: FIXED_NOW.getTime() - 1,
      },
    ],
  });
  const built = buildProactiveContext({ state, recent: [], now: FIXED_NOW, maxChars: 12_000 });
  const parsed = JSON.parse(built.text) as Record<string, unknown>;
  assert.equal(parsed.version, 1);
  assert.equal(parsed.revision, 7);
  assert.equal(built.revision, 7);
  assert.deepEqual(parsed.preferences, [{
    id: "pref-1",
    text: "Prefers TypeScript release notes",
    scope: "subscriptions",
    source: { conversationId: 1, entryId: 3 },
    expiresAt: null,
  }]);
  assert.deepEqual(parsed.task, {
    status: "active", goal: "Ship the loop", scope: "release", constraints: ["No downtime"],
    progress: [], blockers: [], nextStep: "Tag v1", notes: null,
  });
  assert.equal(built.summary.preferences, 1);
  assert.equal(built.summary.task, true);
  assert.equal(built.summary.truncated, false);
});

test("empty memory stays explicitly empty; no preference or profile is invented", () => {
  const built = buildProactiveContext({ state: workingState(), recent: [], now: FIXED_NOW, maxChars: 12_000 });
  assert.deepEqual(JSON.parse(built.text), {
    version: 1,
    revision: 7,
    task: { status: "none" },
    preferences: [],
    profile: [],
    recent: [],
  });
  assert.deepEqual(built.summary, { preferences: 0, profile: 0, recent: 0, task: false, bytes: Buffer.byteLength(built.text, "utf8"), truncated: false });
});

test("context trimming drops fields in priority order and records the truncation", () => {
  const state = workingState({
    revision: 3,
    preferences: Array.from({ length: 6 }, (_, index) => ({
      id: `pref-${index}`, text: `Preference number ${index} `.repeat(4), scope: "global",
      source: { conversationId: 1 as ConversationId, entryId: (index + 1) as EntryId }, expiresAt: null,
    })),
    profile: Array.from({ length: 4 }, (_, index) => ({
      id: `profile-${index}`, text: `Profile fact ${index} `.repeat(4), category: "habit",
      evidence: [{ date: "2026-11-04", id: `segment-${index}`, page: 1 }], updatedAt: FIXED_NOW.getTime(),
    })),
  });
  const recent = Array.from({ length: 20 }, (_, index) => ({ date: "2026-11-04", kind: "note", text: `Recent ${index} `.repeat(8) }));
  const built = buildProactiveContext({ state, recent, now: FIXED_NOW, maxChars: 2_500 });
  const parsed = JSON.parse(built.text) as { preferences: unknown[]; profile: unknown[]; recent: unknown[] };
  assert.equal(built.summary.truncated, true);
  assert.ok(parsed.recent.length < 20);
  assert.ok(parsed.profile.length <= state.profile.length);
  assert.ok(parsed.preferences.length <= state.preferences.length);
  assert.ok(built.text.length <= 2_500, "the serialized context obeys the configured character limit");
  assert.ok((JSON.parse(built.text).omittedFields as string[]).includes("recent"));
  assert.equal(built.summary.preferences, parsed.preferences.length);
  assert.equal(built.summary.profile, parsed.profile.length);
  assert.equal(built.summary.recent, parsed.recent.length);
});

test("context bounds valid large tasks by omitting complete fields with explicit markers", () => {
  for (const goal of ["g".repeat(500), "\"".repeat(500)]) {
    const state = workingState({
      task: {
        status: "active", goal, scope: "s".repeat(500),
        constraints: Array(16).fill("c".repeat(400)),
        progress: [], blockers: Array(16).fill("b".repeat(400)),
        nextStep: "n".repeat(400), notes: "N".repeat(2_000), sources: [],
      },
    });
    assert.equal(Value.Check(WorkingStateSchema, state), true);
    const original = structuredClone(state);
    const built = buildProactiveContext({ state, recent: [], now: FIXED_NOW, maxChars: 1_000 });
    const parsed = JSON.parse(built.text) as { task: Record<string, unknown>; omittedFields: string[] };
    assert.ok(built.text.length <= 1_000);
    assert.equal(parsed.task.status, "active");
    assert.equal(built.summary.truncated, true);
    assert.ok(parsed.omittedFields.includes("task.blockers"));
    for (const [key, value] of Object.entries(parsed.task)) {
      assert.deepEqual(value, (state.task as Record<string, unknown>)[key]);
    }
    if (parsed.task.goal === undefined) assert.ok(parsed.omittedFields.includes("task.goal"));
    else assert.equal(parsed.task.goal, goal);
    assert.deepEqual(state, original, "rendering never changes the source memory");
  }
});

test("the recent segment cap and character trimming both record omissions in the snapshot", () => {
  const recent = Array.from({ length: 21 }, (_, index) => ({ date: "2026-11-05", kind: "note", text: String(index) }));
  const full = buildProactiveContext({ state: workingState(), recent, now: FIXED_NOW, maxChars: 12_000 });
  const parsed = JSON.parse(full.text);
  assert.equal(parsed.recent.length, 20);
  assert.equal(parsed.recent[0].text, "1");
  assert.deepEqual(parsed.omittedFields, ["recent"]);
  assert.equal(full.summary.truncated, true);
  const bounded = buildProactiveContext({ state: workingState(), recent, now: FIXED_NOW, maxChars: 1_000 });
  assert.ok(bounded.text.length <= 1_000);
  assert.ok(JSON.parse(bounded.text).recent.length < 20);
  assert.deepEqual(JSON.parse(bounded.text).omittedFields, ["recent"]);
  assert.equal(bounded.summary.truncated, true);
});

test("proactive message is framed by the host and preserves the verified URL", () => {
  const text = proactiveMessage([item("https://example.com/a", "Release notes")]);
  assert.match(text, /^主动发现（1 条）/);
  assert.match(text, /1\. Release notes/);
  assert.match(text, /https:\/\/example\.com\/a/);
  assert.match(text, /为什么相关：Relevant/);
});

test("triggers are idempotent and exactly one claimant executes a run", async () => {
  const { now } = fixedClock();
  await withStore(async (store) => {
    const first = store.enqueueTrigger({ kind: "daily", triggerKey: "daily:2026-11-05", timezone: "UTC" });
    assert.equal(first.created, true);
    assert.equal(first.run.status, "queued");
    assert.equal(first.run.localDate, "2026-11-05");
    const replay = store.enqueueTrigger({ kind: "daily", triggerKey: "daily:2026-11-05", timezone: "UTC" });
    assert.equal(replay.created, false);
    assert.deepEqual(replay.run, first.run);
    assert.deepEqual(replay.run, store.get(first.run.id));

    const claimed = store.claimNext();
    assert.equal(claimed?.id, first.run.id);
    assert.equal(claimed?.status, "running");
    assert.notEqual(claimed?.startedAt, null);
    assert.equal(store.claimNext(), undefined);
  }, { now });
});

test("manual trigger replay keeps its metadata after reopening SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-proactive-replay-"));
  const path = join(directory, "proactive.sqlite");
  let store = new ProactiveStore(path);
  try {
    const first = store.enqueueTrigger({ kind: "manual", triggerKey: "manual:stable", timezone: "UTC" });
    store.close();
    store = new ProactiveStore(path);
    const replay = store.enqueueTrigger({ kind: "manual", triggerKey: "manual:stable", timezone: "UTC" });
    assert.equal(replay.created, false);
    assert.deepEqual(replay.run, first.run);
    assert.equal(replay.run.triggerKind, "manual");
    assert.equal(replay.run.triggerKey, "manual:stable");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("acceptNotify enforces dedupe, the per-decision limit and the daily cap transactionally", async () => {
  const { now } = fixedClock();
  const limits = { ...PROACTIVE_LIMITS, maxPerDay: 1 };
  await withStore(async (store) => {
    const first = claim(store);
    assert.ok(first);
    const decided = store.acceptNotify(first.id, {
      items: [item("https://example.com/a", "A"), item("https://example.com/a#copy", "A copy"), item("https://example.com/b", "B")],
      reason: "Two distinct sources",
      toolCalls: 2,
      tokens: 10,
    });
    assert.equal(decided.status, "decided");
    assert.equal(decided.decision, "notify");
    assert.deepEqual(decided.items.map(({ url }) => url), ["https://example.com/a", "https://example.com/b"]);
    assert.equal(decided.toolCalls, 2);

    const second = claim(store);
    assert.ok(second);
    const capped = accepted(store, second.id, ["https://example.com/c"]);
    assert.equal(capped.status, "skipped");
    assert.equal(capped.decision, "skip");
    assert.equal(capped.reason, "daily-cap");
  }, { now, limits });

  await withStore(async (store) => {
    const first = claim(store);
    assert.ok(first);
    accepted(store, first.id, ["https://example.com/a"]);
    const second = claim(store);
    assert.ok(second);
    const duplicate = accepted(store, second.id, ["https://example.com/a#again"]);
    assert.equal(duplicate.status, "skipped");
    assert.equal(duplicate.reason, "no-new-items");
  }, { now, limits: { ...PROACTIVE_LIMITS, maxPerDay: 10 } });
});

test("backlogged runs share the notify acceptance day's quota in the configured timezone", async () => {
  const { clock, now } = fixedClock(new Date("2026-11-04T15:50:00Z"));
  await withStore(async (store) => {
    const old = store.enqueueTrigger({ kind: "manual", timezone: "Asia/Shanghai" }).run;
    assert.equal(old.localDate, "2026-11-04");
    clock.time = new Date("2026-11-04T16:10:00Z");
    const today = store.enqueueTrigger({ kind: "manual", timezone: "Asia/Shanghai" }).run;
    assert.equal(today.localDate, "2026-11-05");
    assert.equal(store.claimNext()?.id, old.id);
    const first = accepted(store, old.id);
    assert.equal(first.status, "decided");
    assert.equal(first.quotaDate, "2026-11-05");
    assert.equal(first.decidedAt, clock.time.toISOString());
    assert.equal(store.claimNext()?.id, today.id);
    const capped = accepted(store, today.id, ["https://example.com/today"]);
    assert.equal(capped.reason, "daily-cap");
    assert.equal(capped.quotaDate, null);
    clock.time = new Date("2026-11-05T16:10:00Z");
    const nextDay = claim(store);
    assert.equal(accepted(store, nextDay.id, ["https://example.com/next-day"]).quotaDate, "2026-11-06");
  }, { now, timezone: "Asia/Shanghai" });
});

test("a failed delivery still consumes the quota for accepting notify that day", async () => {
  const { now } = fixedClock();
  await withStore(async (store) => {
    const first = claim(store);
    accepted(store, first.id);
    store.markDelivering(first.id, `proactive:${first.id}`);
    store.reconcileDelivery(first.id, "delivery_failed");
    const second = claim(store);
    assert.equal(accepted(store, second.id, ["https://example.com/second"]).reason, "daily-cap");
  }, { now });
});

test("legacy SQLite decisions migrate quota dates from decidedAt and keep them on later opens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-proactive-migration-"));
  const path = join(directory, "proactive.sqlite");
  const { clock, now } = fixedClock(new Date("2026-11-03T08:00:00Z"));
  let store = new ProactiveStore(path, { now });
  try {
    const run = claim(store);
    clock.time = new Date("2026-11-04T16:10:00Z");
    accepted(store, run.id);
    store.close();
    // Recreate the previous schema without quotaDate while preserving a real accepted row.
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec("DROP INDEX proactive_runs_quota; ALTER TABLE proactive_runs DROP COLUMN quotaDate;");
    } finally {
      legacy.close();
    }
    store = new ProactiveStore(path, { now, timezone: "Asia/Shanghai" });
    assert.equal(store.get(run.id)?.localDate, "2026-11-03");
    assert.equal(store.get(run.id)?.quotaDate, "2026-11-05");
    assert.equal(store.get(run.id)?.status, "decided");
    const second = claim(store);
    assert.equal(accepted(store, second.id, ["https://example.com/second"]).reason, "daily-cap");
    store.close();
    store = new ProactiveStore(path, { now, timezone: "UTC" });
    assert.equal(store.get(run.id)?.quotaDate, "2026-11-05", "a saved quota date is not recalculated on restart");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("delivery reconciliation is terminal and an uncertain result is never resent", async () => {
  const { now } = fixedClock();
  await withStore(async (store) => {
    const run = claim(store);
    assert.ok(run);
    accepted(store, run.id);
    const delivering = store.markDelivering(run.id, "proactive:1");
    assert.equal(delivering.status, "delivering");

    assert.equal(store.reconcileDelivery(run.id, "delivery_uncertain", "TIMEOUT")?.status, "delivery_uncertain");
    const statuses = new Map<string, ProactiveDeliveryState>([["proactive:1", "sent"]]);
    const scheduler = new ProactiveScheduler({
      store,
      config: { ...PROACTIVE_LIMITS, dailyAt: "23:59", timezone: "UTC" },
      runner: { run: async () => assert.fail("an uncertain delivery must not execute a run") },
      inbox: { deliveryStatus: (requestId) => statuses.get(requestId) ?? "missing" },
      now,
      log: () => {},
    });
    await scheduler.runDue();
    assert.equal(store.get(run.id)?.status, "delivery_uncertain", "a sent-looking Inbox row cannot overwrite a terminal unknown");

    const resolved = store.resolveDelivery(run.id, "delivered");
    assert.equal(resolved.status, "delivered");
    assert.equal(resolved.deliveryStatus, "delivered");
    assert.throws(() => store.resolveDelivery(run.id, "failed"), /is delivered/);
  }, { now });
});

test("startup recovery requeues only runs with neither a conversation nor a submission", async () => {
  const { now } = fixedClock();
  await withStore(async (store) => {
    const safe = claim(store);
    assert.ok(safe);
    const attaching = claim(store);
    store.attachConversation(attaching.id, "8");
    store.recordProgress(attaching.id, { toolCalls: 3, tokens: 42 });
    const resumable = claim(store);
    assert.ok(resumable);
    store.attachConversation(resumable.id, "9");
    store.attachSubmission(resumable.id, "10");
    const decided = claim(store);
    assert.ok(decided);
    accepted(store, decided.id);

    store.recover();
    assert.equal(store.get(safe.id)?.status, "queued");
    assert.equal(store.get(safe.id)?.conversationId, null);
    assert.equal(store.get(attaching.id)?.status, "running");
    assert.equal(store.get(attaching.id)?.conversationId, "8");
    assert.equal(store.get(attaching.id)?.submissionId, null);
    assert.equal(store.get(attaching.id)?.toolCalls, 3);
    assert.equal(store.get(attaching.id)?.tokens, 42);
    assert.equal(store.get(resumable.id)?.status, "running");
    assert.equal(store.get(resumable.id)?.submissionId, "10");
    assert.equal(store.get(decided.id)?.status, "decided");
    assert.deepEqual(store.unfinished().map(({ id }) => id), [attaching.id, resumable.id, decided.id]);
    assert.deepEqual(store.delivering(), []);
  }, { now });
});

test("the daily trigger is created once per local day and only after the configured time", async () => {
  const { clock } = fixedClock(new Date("2026-11-05T00:00:00.000Z"));
  await withStore(async (store) => {
    const config: ProactiveConfig = { ...PROACTIVE_LIMITS, dailyAt: "09:00", timezone: "Asia/Shanghai" };
    const scheduler = new ProactiveScheduler({
      store, config, runner: { run: async () => undefined }, inbox: { deliveryStatus: () => "missing" },
      now: () => clock.time, log: () => {},
    });
    scheduler.enqueueDaily(clock.time);
    assert.equal(store.list().length, 0, "00:00 UTC is 08:00 in Shanghai, before 09:00");

    clock.time = new Date("2026-11-05T01:00:00.000Z");
    scheduler.enqueueDaily(clock.time);
    scheduler.enqueueDaily(new Date("2026-11-05T02:00:00.000Z"));
    const runs = store.list();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.triggerKey, "daily:2026-11-05");
    assert.equal(runs[0]?.triggerKind, "daily");
  });
});

test("the scheduler reconciles Inbox outcomes and turns an unexpected runner error into a failure", async () => {
  const { now } = fixedClock();
  await withStore(async (store) => {
    const sent = claim(store);
    assert.ok(sent);
    accepted(store, sent.id, ["https://example.com/sent"]);
    store.markDelivering(sent.id, "proactive:1");
    const failed = claim(store);
    assert.ok(failed);
    accepted(store, failed.id, ["https://example.com/failed"]);
    store.markDelivering(failed.id, "proactive:2");
    const missing = claim(store);
    assert.ok(missing);
    accepted(store, missing.id, ["https://example.com/missing"]);
    store.markDelivering(missing.id, "proactive:3");
    const thrown = store.enqueueTrigger({ kind: "manual", triggerKey: `test:thrown:${++claimSequence}`, timezone: "UTC" }).run;

    const states = new Map<string, ProactiveDeliveryState>([
      ["proactive:1", "sent"], ["proactive:2", "failed"], ["proactive:3", "missing"],
    ]);
    const errors: string[] = [];
    let claims = 0;
    const scheduler = new ProactiveScheduler({
      store,
      config: { ...PROACTIVE_LIMITS, dailyAt: "23:59", timezone: "UTC" },
      runner: {
        run: async (runId) => {
          claims += 1;
          assert.equal(runId, thrown.id);
          throw new Error("boom");
        },
      },
      inbox: { deliveryStatus: (requestId) => states.get(requestId) ?? "ready" },
      now,
      log: (line) => errors.push(line),
    });
    await scheduler.runDue();

    assert.equal(store.get(sent.id)?.status, "delivered");
    assert.equal(store.get(failed.id)?.status, "delivery_failed");
    assert.equal(store.get(failed.id)?.deliveryError, "DELIVERY_FAILED");
    assert.equal(store.get(missing.id)?.status, "delivery_uncertain");
    assert.equal(store.get(missing.id)?.deliveryError, "DELIVERY_MISSING");
    assert.equal(store.get(thrown.id)?.status, "failed");
    assert.equal(store.get(thrown.id)?.errorCode, "PROACTIVE_RUN_ERROR");
    assert.equal(claims, 1);
    assert.match(errors.join("\n"), /failed unexpectedly/);
  }, { now, limits: { ...PROACTIVE_LIMITS, maxPerDay: 10 } });
});

test("a shutdown signal leaves a claimed run resumable instead of recording a failure", async () => {
  const { now } = fixedClock();
  await withStore(async (store) => {
    const queued = store.enqueueTrigger({ kind: "manual", triggerKey: `test:shutdown:${++claimSequence}`, timezone: "UTC" }).run;
    const controller = new AbortController();
    const scheduler = new ProactiveScheduler({
      store,
      config: { ...PROACTIVE_LIMITS, dailyAt: "23:59", timezone: "UTC" },
      runner: {
        run: async (runId) => {
          assert.equal(runId, queued.id);
          controller.abort();
          throw new Error("interrupted");
        },
      },
      inbox: { deliveryStatus: () => "ready" },
      now,
      log: () => {},
    });
    await scheduler.runDue(controller.signal);
    const after = store.get(queued.id);
    assert.equal(after?.status, "running", "the run keeps its durable identity for the next start");
    assert.equal(after?.errorCode, null);
  }, { now });
});
