import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CreateRoutineInput } from "../src/routines/protocol.js";
import { SqliteRoutineStore } from "../src/routines/store.js";

function clock(start = "2026-11-13T22:00:00.000Z") {
  const state = { time: new Date(start) };
  return {
    now: () => state.time,
    set(iso: string): void { state.time = new Date(iso); },
    advance(ms: number): void { state.time = new Date(state.time.getTime() + ms); },
  };
}

function input(now: Date, overrides: Partial<CreateRoutineInput> = {}): CreateRoutineInput {
  return {
    chatId: "42",
    title: "daily brief",
    timezone: "Asia/Shanghai",
    mode: "agent",
    brief: "summarize the last day",
    delivery: "always",
    schedule: { kind: "daily", at: "08:00" },
    now,
    ...overrides,
  };
}

async function withStore(run: (store: SqliteRoutineStore, path: string) => Promise<void>, options: { now?: () => Date } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aster-routines-"));
  const path = join(directory, "routines.sqlite");
  const store = new SqliteRoutineStore(path, options);
  try {
    await run(store, path);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("a created routine gets a schedule and one claim per slot", async () => {
  const time = clock();
  await withStore(async (store) => {
    const view = store.create(input(time.now()));
    assert.equal(view.schedule.nextDueAt, "2026-11-14T00:00:00.000Z");
    assert.equal(store.nextDueAt(), "2026-11-14T00:00:00.000Z");

    time.set("2026-11-14T00:00:00.000Z");
    const claimed = store.claimDue(time.now(), 6);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.run.runKey, "sched:2026-11-14T00:00:00.000Z");
    assert.equal(claimed[0]?.run.status, "queued");
    assert.equal(store.claimDue(time.now(), 6).length, 0, "the slot is advanced inside the claim");
    assert.equal(store.get(view.id)?.schedule.nextDueAt, "2026-11-15T00:00:00.000Z");

    const run = store.claimRun(time.now(), 60_000);
    assert.equal(run?.attempts, 1);
    assert.equal(store.claimRun(time.now(), 60_000), undefined, "a running row is not claimable twice");
    store.finish(run!.id, "succeeded", { reply: "done" });
    assert.equal(store.runs(view.id)[0]?.status, "succeeded");
    assert.equal(store.get(view.id)?.consecutiveFailures, 0);
  }, { now: time.now });
});

test("a slot missed by more than the grace window is skipped, not replayed", async () => {
  const time = clock();
  await withStore(async (store) => {
    const view = store.create(input(time.now()));
    time.set("2026-11-18T00:00:00.000Z");
    const claimed = store.claimDue(time.now(), 6);
    assert.equal(claimed.length, 0);
    const runs = store.runs(view.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "skipped");
    assert.equal(runs[0]?.errorCode, "MISSED_WINDOW");
    assert.equal(store.get(view.id)?.schedule.nextDueAt, "2026-11-19T00:00:00.000Z");
  }, { now: time.now });
});

test("a failed run can be retried after its not-before time", async () => {
  const time = clock();
  await withStore(async (store) => {
    store.create(input(time.now()));
    time.set("2026-11-14T00:00:00.000Z");
    store.claimDue(time.now(), 6);
    const run = store.claimRun(time.now(), 60_000);
    assert.notEqual(run, undefined);
    store.retry(run!.id, new Date(time.now().getTime() + 120_000));
    assert.equal(store.claimRun(time.now(), 60_000), undefined, "not before the backoff");
    time.advance(121_000);
    const retried = store.claimRun(time.now(), 60_000);
    assert.equal(retried?.id, run!.id);
    assert.equal(retried?.attempts, 2);
  }, { now: time.now });
});

test("startup recovery fails an interrupted run and counts it against the routine", async () => {
  const time = clock();
  const directory = await mkdtemp(join(tmpdir(), "aster-routines-recovery-"));
  const path = join(directory, "routines.sqlite");
  try {
    const first = new SqliteRoutineStore(path, { now: time.now });
    const view = first.create(input(time.now()));
    time.set("2026-11-14T00:00:00.000Z");
    first.claimDue(time.now(), 6);
    const run = first.claimRun(time.now(), 60_000);
    assert.notEqual(run, undefined);
    first.close();

    const second = new SqliteRoutineStore(path, { now: time.now });
    assert.equal(second.recover(), 1);
    assert.equal(second.runs(view.id)[0]?.status, "failed");
    assert.equal(second.runs(view.id)[0]?.errorCode, "PROCESS_INTERRUPTED");
    assert.equal(second.get(view.id)?.consecutiveFailures, 1);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("usage counts agent runs and names the busiest task", async () => {
  const time = clock();
  await withStore(async (store) => {
    const first = store.create(input(time.now()));
    const second = store.create(input(time.now(), { title: "second", schedule: { kind: "daily", at: "09:00" } }));
    const notification = store.create(input(time.now(), {
      title: "water",
      mode: "notify",
      brief: undefined,
      text: "drink water",
      schedule: { kind: "daily", at: "10:00" },
    }));
    for (const view of [first, first, second, notification]) {
      const run = store.enqueueManual(view.id, time.now());
      store.finish(run.id, "succeeded", { reply: "ok" });
    }
    const usage = store.usage("2026-11-13T00:00:00.000Z", "2026-11-15T00:00:00.000Z");
    assert.equal(usage.agentRuns, 3);
    assert.equal(usage.notifyRuns, 1);
    assert.equal(usage.top[0]?.id, first.id);
    assert.equal(usage.top[0]?.runs, 2);
  }, { now: time.now });
});
