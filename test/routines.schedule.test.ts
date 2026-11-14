import assert from "node:assert/strict";
import test from "node:test";
import { RoutineError, type RoutineSchedule } from "../src/routines/protocol.js";
import { describeSchedule, nextOccurrence, parseSchedule } from "../src/routines/schedule.js";

function code(error: unknown): string | undefined {
  return error instanceof RoutineError ? error.code : undefined;
}

function rejected(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return code(error);
  }
  assert.fail("expected the schedule to be rejected");
}

test("daily schedules resolve the next local wall time, strictly in the future", () => {
  const schedule = parseSchedule({ kind: "daily", at: "08:00" }, 5);
  assert.equal(
    nextOccurrence(schedule, new Date("2026-11-13T23:00:00.000Z"), "Asia/Shanghai").toISOString(),
    "2026-11-14T00:00:00.000Z",
    "07:00 local waits for 08:00 the same day",
  );
  assert.equal(
    nextOccurrence(schedule, new Date("2026-11-14T00:00:00.000Z"), "Asia/Shanghai").toISOString(),
    "2026-11-15T00:00:00.000Z",
    "exactly on the slot means the next day, never a duplicate",
  );
});

test("weekly schedules pick the next listed weekday and skip the others", () => {
  const schedule = parseSchedule({ kind: "weekly", days: ["mon"], at: "09:00" }, 5);
  // 2026-11-14 is a Saturday, 08:00 in Shanghai.
  assert.equal(
    nextOccurrence(schedule, new Date("2026-11-14T00:00:00.000Z"), "Asia/Shanghai").toISOString(),
    "2026-11-16T01:00:00.000Z",
  );
});

test("every schedules advance by the interval, and a window moves to its start", () => {
  const plain = parseSchedule({ kind: "every", everyMinutes: 60 }, 5);
  assert.equal(
    nextOccurrence(plain, new Date("2026-11-14T01:00:00.000Z"), "Asia/Shanghai").toISOString(),
    "2026-11-14T02:00:00.000Z",
  );
  const windowed = parseSchedule({ kind: "every", everyMinutes: 30, from: "09:00", to: "21:00" }, 5);
  // 21:00 local is outside the half-open window, so the next run is the next morning.
  assert.equal(
    nextOccurrence(windowed, new Date("2026-11-14T13:00:00.000Z"), "Asia/Shanghai").toISOString(),
    "2026-11-15T01:00:00.000Z",
  );
});

test("a spring-forward gap runs the same minute after the jump, once", () => {
  const schedule = parseSchedule({ kind: "daily", at: "02:30" }, 5);
  assert.equal(
    nextOccurrence(schedule, new Date("2026-03-07T12:00:00.000Z"), "America/New_York").toISOString(),
    "2026-03-08T07:30:00.000Z",
    "02:30 does not exist on 2026-03-08; 03:30 EDT is 07:30Z",
  );
});

test("a fall-back overlap runs at the earlier of the two instants", () => {
  const schedule = parseSchedule({ kind: "daily", at: "01:30" }, 5);
  assert.equal(
    nextOccurrence(schedule, new Date("2026-10-31T12:00:00.000Z"), "America/New_York").toISOString(),
    "2026-11-01T05:30:00.000Z",
    "01:30 happens twice; the first (EDT) wins",
  );
});

test("malformed schedules are refused with a host reason code", () => {
  assert.equal(rejected(() => parseSchedule({ kind: "daily", at: "8" }, 5)), "ROUTINE_INVALID_TIME");
  assert.equal(rejected(() => parseSchedule({ kind: "daily", at: "24:00" }, 5)), "ROUTINE_INVALID_TIME");
  assert.equal(rejected(() => parseSchedule({ kind: "weekly", at: "08:00" }, 5)), "ROUTINE_INVALID_SCHEDULE");
  assert.equal(rejected(() => parseSchedule({ kind: "weekly", days: [], at: "08:00" }, 5)), "ROUTINE_INVALID_SCHEDULE");
  assert.equal(rejected(() => parseSchedule({ kind: "every", everyMinutes: 1 }, 5)), "ROUTINE_INVALID_INTERVAL");
  assert.equal(
    rejected(() => parseSchedule({ kind: "every", everyMinutes: 30, from: "21:00", to: "09:00" }, 5)),
    "ROUTINE_INVALID_SCHEDULE",
  );
});

test("a schedule reads back in one line for the model", () => {
  const schedule: RoutineSchedule = { kind: "weekly", days: [1, 3], at: "09:00" };
  assert.equal(describeSchedule(schedule, "Asia/Shanghai"), "weekly on mon,wed at 09:00 (Asia/Shanghai)");
});
