import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RoutineRunner, RoutinesConfig } from "../src/routines/protocol.js";
import { createRoutines } from "../src/routines/runtime.js";
import { SqliteRoutineStore } from "../src/routines/store.js";

function clock(start = "2026-11-14T00:00:00.000Z") {
  const state = { time: new Date(start) };
  return {
    now: () => state.time,
    set(iso: string): void { state.time = new Date(iso); },
    advance(ms: number): void { state.time = new Date(state.time.getTime() + ms); },
  };
}

function config(overrides: Partial<RoutinesConfig> = {}): RoutinesConfig {
  return {
    enabled: true,
    paused: false,
    timezone: "Asia/Shanghai",
    maxPerOwner: 50,
    minIntervalMinutes: 5,
    maxRunsPerDay: 0,
    runTimeoutMs: 600_000,
    summaryEnabled: false,
    summaryLocalTime: "21:00",
    retentionDays: 90,
    ...overrides,
  };
}

async function withRuntime(
  run: (context: {
    store: SqliteRoutineStore;
    runtime: ReturnType<typeof createRoutines>;
    sent: string[];
  }) => Promise<void>,
  options: { now?: () => Date; config?: RoutinesConfig; runner?: RoutineRunner } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "aster-routines-runtime-"));
  const now = options.now ?? (() => new Date("2026-11-14T00:00:00.000Z"));
  const store = new SqliteRoutineStore(join(directory, "routines.sqlite"), { now });
  const sent: string[] = [];
  const runtime = createRoutines({
    store,
    config: options.config ?? config(),
    chatId: "42",
    now,
    log: () => {},
    deliver: async (_chatId, text) => {
      sent.push(text);
      return String(sent.length);
    },
    run: options.runner ?? (async () => ({ conversationId: 7, text: "report" })),
  });
  try {
    await run({ store, runtime, sent });
  } finally {
    await runtime.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function create(store: SqliteRoutineStore, now: Date, overrides: Partial<Parameters<SqliteRoutineStore["create"]>[0]> = {}) {
  return store.create({
    chatId: "42",
    title: "daily brief",
    timezone: "Asia/Shanghai",
    mode: "agent",
    brief: "summarize the day",
    delivery: "always",
    schedule: { kind: "daily", at: "09:00" },
    now,
    ...overrides,
  });
}

test("a notify routine sends its template with local date and time, no model call", async () => {
  const time = clock();
  await withRuntime(async ({ store, runtime, sent }) => {
    const view = create(store, time.now(), {
      mode: "notify",
      brief: undefined,
      text: "提醒：{{date}} {{time}}",
    });
    store.enqueueManual(view.id, time.now());
    const result = await runtime.tickOnce();
    assert.equal(result.ran, 1);
    assert.deepEqual(sent, ["提醒：2026-11-14 08:00"]);
    assert.equal(store.runs(view.id)[0]?.status, "succeeded");
  }, { now: time.now });
});

test("a report-only agent run that answers NO_REPORT is suppressed", async () => {
  const time = clock();
  await withRuntime(async ({ store, runtime, sent }) => {
    const view = create(store, time.now(), { delivery: "report" });
    store.enqueueManual(view.id, time.now());
    const result = await runtime.tickOnce();
    assert.equal(result.ran, 1);
    assert.deepEqual(sent, []);
    assert.equal(store.runs(view.id)[0]?.status, "suppressed");
    assert.equal(store.get(view.id)?.conversationId, 7);
  }, { now: time.now, runner: async () => ({ conversationId: 7, text: "NO_REPORT" }) });
});

test("a recoverable failure is retried once after the backoff and then delivered", async () => {
  const time = clock();
  let calls = 0;
  const runner: RoutineRunner = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("timed out"), { code: "AGENT_TIMEOUT" });
    return { conversationId: 9, text: "recovered" };
  };
  await withRuntime(async ({ store, runtime, sent }) => {
    const view = create(store, time.now());
    store.enqueueManual(view.id, time.now());
    await runtime.tickOnce();
    assert.deepEqual(sent, [], "the first failure waits for the backoff");
    assert.equal(store.runs(view.id)[0]?.status, "queued");

    time.advance(121_000);
    await runtime.tickOnce();
    assert.deepEqual(sent, ["recovered"]);
    assert.equal(store.runs(view.id)[0]?.status, "succeeded");
  }, { now: time.now, runner });
});

test("the daily summary is sent once and counts agent runs", async () => {
  const time = clock("2026-11-14T13:30:00.000Z"); // 21:30 in Shanghai
  await withRuntime(async ({ store, runtime, sent }) => {
    const view = create(store, time.now(), { delivery: "always" });
    store.enqueueManual(view.id, time.now());
    await runtime.tickOnce();
    assert.equal(sent.length, 2, "the run plus one usage summary");
    assert.match(sent[1] ?? "", /今日用量/);
    assert.match(sent[1] ?? "", /agent 运行 1 次/);
    await runtime.tickOnce();
    assert.equal(sent.length, 2, "the summary is not repeated the same day");
    assert.equal(store.meta("summary:2026-11-14"), "1");
  }, { now: time.now, config: config({ summaryEnabled: true }) });
});

test("an optional daily cap skips extra agent runs and says so once", async () => {
  const time = clock();
  await withRuntime(async ({ store, runtime, sent }) => {
    const view = create(store, time.now());
    store.enqueueManual(view.id, time.now());
    store.enqueueManual(view.id, time.now());
    await runtime.tickOnce();
    assert.equal(sent.length, 2, "one run plus one quota notice");
    assert.match(sent[1] ?? "", /额度已用完/);
    assert.equal(store.runs(view.id).filter((run) => run.status === "skipped").length, 1);
  }, { now: time.now, config: config({ maxRunsPerDay: 1 }) });
});

test("the process kill switch dispatches nothing and keeps the queue", async () => {
  const time = clock();
  await withRuntime(async ({ store, runtime, sent }) => {
    const view = create(store, time.now());
    store.enqueueManual(view.id, time.now());
    const result = await runtime.tickOnce();
    assert.deepEqual(result, { claimed: 0, ran: 0, delivered: 0, failed: 0 });
    assert.deepEqual(sent, []);
    assert.equal(store.runs(view.id)[0]?.status, "queued");
  }, { now: time.now, config: config({ paused: true }) });
});
