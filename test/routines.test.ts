import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigurationError, readRoutinesConfig } from "../src/config.js";
import { RoutineError, type RoutinesConfig } from "../src/routines/protocol.js";
import { createRoutineFromArgs } from "../src/routines/tools.js";
import { SqliteRoutineStore } from "../src/routines/store.js";

const NOW = new Date("2026-11-13T22:00:00.000Z");

function config(overrides: Partial<RoutinesConfig> = {}): RoutinesConfig {
  return {
    enabled: true,
    paused: false,
    timezone: "Asia/Shanghai",
    maxPerOwner: 50,
    minIntervalMinutes: 5,
    maxRunsPerDay: 0,
    runTimeoutMs: 600_000,
    summaryEnabled: true,
    summaryLocalTime: "21:00",
    retentionDays: 90,
    ...overrides,
  };
}

function rejected(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof RoutineError ? error.code : undefined;
  }
  assert.fail("expected the operation to be rejected");
}

test("routine config defaults to enabled, Shanghai time and no hard cap", () => {
  const defaults = readRoutinesConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.paused, false);
  assert.equal(defaults.timezone, "Asia/Shanghai");
  assert.equal(defaults.maxRunsPerDay, 0);
  assert.equal(defaults.summaryLocalTime, "21:00");
  assert.equal(defaults.minIntervalMinutes, 5);
  assert.equal(readRoutinesConfig({ ROUTINES_PAUSED: "1" }).paused, true);
  assert.equal(readRoutinesConfig({ ROUTINES_SUMMARY_TIME: "9:05" }).summaryLocalTime, "09:05");
  assert.equal(readRoutinesConfig({ ROUTINES_MAX_RUNS_PER_DAY: "100" }).maxRunsPerDay, 100);
  assert.throws(() => readRoutinesConfig({ ROUTINES_ENABLED: "yes" }), (error: unknown) => error instanceof ConfigurationError);
  assert.throws(() => readRoutinesConfig({ ROUTINES_TIMEZONE: "Mars/Olympus" }), /ROUTINES_TIMEZONE/);
  assert.throws(() => readRoutinesConfig({ ROUTINES_SUMMARY_TIME: "25:00" }), /ROUTINES_SUMMARY_TIME/);
  assert.throws(() => readRoutinesConfig({ ROUTINES_MAX_RUNS_PER_DAY: "-1" }), /ROUTINES_MAX_RUNS_PER_DAY/);
});

test("chat creation derives the mode from what was supplied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-routines-tools-"));
  const store = new SqliteRoutineStore(join(directory, "routines.sqlite"));
  try {
    const briefed = createRoutineFromArgs(store, config(), "42", {
      title: "morning",
      kind: "daily",
      at: "08:00",
      brief: "write the morning brief",
    }, NOW);
    assert.equal(briefed.mode, "agent");
    assert.equal(briefed.schedule.nextDueAt, "2026-11-14T00:00:00.000Z");
    assert.equal(briefed.timezone, "Asia/Shanghai");

    const notification = createRoutineFromArgs(store, config(), "42", {
      title: "water",
      kind: "every",
      every_minutes: 120,
      text: "drink water",
      from: "09:00",
      to: "21:00",
    }, NOW);
    assert.equal(notification.mode, "notify");
    assert.equal(store.list("42").length, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid creations are refused before a row exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-routines-tools-"));
  const store = new SqliteRoutineStore(join(directory, "routines.sqlite"));
  try {
    const settings = config({ maxPerOwner: 1 });
    assert.equal(rejected(() => createRoutineFromArgs(store, settings, "42", {
      title: "agent", kind: "daily", at: "08:00", mode: "agent",
    }, NOW)), "ROUTINE_MISSING_BRIEF");
    assert.equal(rejected(() => createRoutineFromArgs(store, settings, "42", {
      title: "notify", kind: "daily", at: "08:00", mode: "notify",
    }, NOW)), "ROUTINE_MISSING_TEXT");
    assert.equal(rejected(() => createRoutineFromArgs(store, settings, "42", {
      title: "report", kind: "daily", at: "08:00", mode: "notify", text: "x", delivery: "report",
    }, NOW)), "ROUTINE_INVALID_SCHEDULE");
    assert.equal(rejected(() => createRoutineFromArgs(store, settings, "42", {
      title: "zone", kind: "daily", at: "08:00", brief: "x", timezone: "Mars/Olympus",
    }, NOW)), "ROUTINE_INVALID_TIMEZONE");
    assert.equal(rejected(() => createRoutineFromArgs(store, settings, "42", {
      title: "fast", kind: "every", every_minutes: 1, brief: "x",
    }, NOW)), "ROUTINE_INVALID_INTERVAL");

    createRoutineFromArgs(store, settings, "42", {
      title: "first", kind: "daily", at: "08:00", brief: "x",
    }, NOW);
    assert.equal(rejected(() => createRoutineFromArgs(store, settings, "42", {
      title: "second", kind: "daily", at: "09:00", brief: "x",
    }, NOW)), "ROUTINE_LIMIT_EXCEEDED");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
