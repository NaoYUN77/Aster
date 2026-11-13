/**
 * The calendar half of a routine. A schedule is a small structured value, not a cron string: the
 * model can emit it reliably, the host can validate every field, and a human can read it back.
 * All times are wall-clock times in the routine's own zone; the result is always a UTC instant.
 */

import { RoutineError, WEEKDAYS, type RoutineSchedule, type Weekday } from "./protocol.js";
import {
  addLocalDays,
  dayOfWeek,
  isValidTimeOfDay,
  localParts,
  minutesOfDay,
  normalizeTimeOfDay,
  timeOfDayParts,
  zonedInstant,
} from "./time.js";

export type ScheduleInput = {
  readonly kind: "daily" | "weekly" | "every";
  readonly at?: string;
  readonly days?: readonly Weekday[];
  readonly everyMinutes?: number;
  readonly from?: string;
  readonly to?: string;
};

function timeOrThrow(value: string | undefined, what: string): string {
  if (value === undefined || value.trim() === "") {
    throw new RoutineError("ROUTINE_INVALID_TIME", `${what} must be a local time such as 08:00`);
  }
  const normalized = normalizeTimeOfDay(value);
  if (!isValidTimeOfDay(normalized)) {
    throw new RoutineError("ROUTINE_INVALID_TIME", `${what} must be a 24-hour local time such as 08:00`);
  }
  return normalized;
}

export function parseSchedule(input: ScheduleInput, minIntervalMinutes: number): RoutineSchedule {
  if (input.kind === "daily") {
    return { kind: "daily", at: timeOrThrow(input.at, "at") };
  }
  if (input.kind === "weekly") {
    if (input.days === undefined || input.days.length === 0) {
      throw new RoutineError("ROUTINE_INVALID_SCHEDULE", "a weekly routine needs at least one day");
    }
    const days: number[] = [];
    for (const day of input.days) {
      const index = WEEKDAYS.indexOf(day);
      if (index < 0) throw new RoutineError("ROUTINE_INVALID_SCHEDULE", `unknown weekday: ${String(day)}`);
      days.push(index);
    }
    return { kind: "weekly", days: [...new Set(days)].sort((a, b) => a - b), at: timeOrThrow(input.at, "at") };
  }
  if (input.kind !== "every") {
    throw new RoutineError("ROUTINE_INVALID_SCHEDULE", "kind must be daily, weekly or every");
  }
  const minutes = input.everyMinutes;
  if (minutes === undefined || !Number.isInteger(minutes) || minutes < minIntervalMinutes) {
    throw new RoutineError(
      "ROUTINE_INVALID_INTERVAL",
      `every_minutes must be an integer of at least ${minIntervalMinutes}`,
    );
  }
  if (input.from === undefined && input.to === undefined) {
    return { kind: "every", minutes };
  }
  if (input.from === undefined || input.to === undefined) {
    throw new RoutineError("ROUTINE_INVALID_SCHEDULE", "from and to must be set together");
  }
  const from = timeOrThrow(input.from, "from");
  const to = timeOrThrow(input.to, "to");
  if (minutesOfDay(timeOfDayParts(from)) >= minutesOfDay(timeOfDayParts(to))) {
    throw new RoutineError("ROUTINE_INVALID_SCHEDULE", "the window must start before it ends");
  }
  return { kind: "every", minutes, from, to };
}

/**
 * The first occurrence strictly after `after`. Three passes is enough for a daily or weekly slot:
 * today may be past, and a DST gap can move the wall time by an hour but never by a day.
 */
export function nextOccurrence(schedule: RoutineSchedule, after: Date, timeZone: string): Date {
  if (schedule.kind === "every") return nextEvery(schedule, after, timeZone);
  const now = localParts(after, timeZone);
  const clock = timeOfDayParts(schedule.at);
  const days = schedule.kind === "weekly" ? schedule.days : undefined;
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = addLocalDays(now, offset);
    if (days !== undefined && !days.includes(dayOfWeek(date))) continue;
    const candidate = zonedInstant({ ...date, ...clock }, timeZone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  // A weekly schedule always matches within seven days; reaching here means the stored value is corrupt.
  throw new RoutineError("ROUTINE_INVALID_SCHEDULE", "the schedule produced no next occurrence");
}

function nextEvery(
  schedule: Extract<RoutineSchedule, { kind: "every" }>,
  after: Date,
  timeZone: string,
): Date {
  if (schedule.from === undefined || schedule.to === undefined) {
    return new Date(after.getTime() + schedule.minutes * 60_000);
  }
  const from = timeOfDayParts(schedule.from);
  const to = timeOfDayParts(schedule.to);
  const fromMinute = minutesOfDay(from);
  const toMinute = minutesOfDay(to);
  let candidate = new Date(after.getTime() + schedule.minutes * 60_000);
  for (let guard = 0; guard < 5; guard += 1) {
    const parts = localParts(candidate, timeZone);
    const minute = minutesOfDay(parts);
    if (minute >= fromMinute && minute < toMinute) return candidate;
    const date = minute >= toMinute ? addLocalDays(parts, 1) : parts;
    candidate = zonedInstant({ ...date, ...from }, timeZone);
    if (candidate.getTime() > after.getTime()) {
      // The window start is a valid next occurrence; the interval only matters inside the window.
      return candidate;
    }
    candidate = new Date(after.getTime() + schedule.minutes * 60_000);
  }
  return new Date(after.getTime() + schedule.minutes * 60_000);
}

/** One line for `routine_list`; it names the zone because the same wall time means different instants. */
export function describeSchedule(schedule: RoutineSchedule, timeZone: string): string {
  if (schedule.kind === "daily") return `daily at ${schedule.at} (${timeZone})`;
  if (schedule.kind === "weekly") {
    const days = schedule.days.map((day) => WEEKDAYS[day] ?? String(day)).join(",");
    return `weekly on ${days} at ${schedule.at} (${timeZone})`;
  }
  const window = schedule.from === undefined ? "" : ` between ${schedule.from} and ${schedule.to}`;
  return `every ${schedule.minutes} minutes${window} (${timeZone})`;
}
