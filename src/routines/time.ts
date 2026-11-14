/**
 * Wall-clock arithmetic without a date library. Every routine stores an IANA time zone and a
 * local wall time; the host stores the resulting instant in UTC. Intl is the only authority for
 * what a zone means, so DST changes are resolved from the platform's own tz database.
 */

export type LocalParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatters.set(timeZone, created);
  return created;
}

/** Throws for an unknown zone; callers turn that into a configuration or tool error. */
export function assertTimeZone(timeZone: string): void {
  new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

/** `YYYY-MM-DD` in the zone, used for daily counters and metadata keys. */
export function localDateKey(instant: Date, timeZone: string): string {
  const parts = localParts(instant, timeZone);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function isValidTimeOfDay(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** `8:00` becomes `08:00`; anything else is returned unchanged so validation can reject it. */
export function normalizeTimeOfDay(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return value.trim();
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return value.trim();
  return `${pad(hour)}:${pad(minute)}`;
}

export function timeOfDayParts(value: string): { readonly hour: number; readonly minute: number } {
  const [hour = "0", minute = "0"] = value.split(":");
  return { hour: Number(hour), minute: Number(minute) };
}

/** Millisecond offset of the zone east of UTC at one instant. */
function offsetAt(instantMs: number, timeZone: string): number {
  const parts = localParts(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instantMs;
}

function sameWallTime(instantMs: number, target: { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number }, timeZone: string): boolean {
  const parts = localParts(new Date(instantMs), timeZone);
  return parts.year === target.year && parts.month === target.month && parts.day === target.day
    && parts.hour === target.hour && parts.minute === target.minute;
}

/**
 * The instant at which the zone's wall clock reads `year-month-day hour:minute`.
 *
 * Two cases need a policy rather than a formula. A spring-forward gap has no such wall time: the
 * same minute runs after the jump, so a 02:30 task runs at 03:30. A fall-back overlap has two: the
 * earlier one wins, so the task runs once, before the clock repeats the hour.
 */
export function zonedInstant(
  target: { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number },
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  // Both sides of a transition are represented by the offsets a day either way. Two is the usual
  // number; collecting them all keeps the rule true for zones that skip more than an hour.
  const offsets = new Set([
    offsetAt(utcGuess - 26 * 3_600_000, timeZone),
    offsetAt(utcGuess, timeZone),
    offsetAt(utcGuess + 26 * 3_600_000, timeZone),
  ]);
  const exact: number[] = [];
  for (const offset of offsets) {
    const candidate = utcGuess - offset;
    if (sameWallTime(candidate, target, timeZone)) exact.push(candidate);
  }
  if (exact.length > 0) return new Date(Math.min(...exact));

  // The requested wall time does not exist (DST gap). Pick the earliest candidate whose wall clock
  // has already moved past it.
  let next: number | undefined;
  for (const offset of offsets) {
    const candidate = utcGuess - offset;
    const parts = localParts(new Date(candidate), timeZone);
    const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    if (wall > utcGuess && (next === undefined || candidate < next)) next = candidate;
  }
  if (next !== undefined) return new Date(next);
  throw new Error(`Cannot resolve local time in ${timeZone}`);
}

/** Calendar-day arithmetic on the local date, independent of zone offsets. */
export function addLocalDays(parts: { readonly year: number; readonly month: number; readonly day: number }, days: number): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * 86_400_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** 0 = Sunday, matching `WEEKDAYS`. */
export function dayOfWeek(parts: { readonly year: number; readonly month: number; readonly day: number }): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

export function minutesOfDay(parts: { readonly hour: number; readonly minute: number }): number {
  return parts.hour * 60 + parts.minute;
}
